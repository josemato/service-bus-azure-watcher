'use strict';

const EventEmitter = require('events');
const promiseRetry = require('promise-retry');

const CHECK_CONCURRENCY_TIMER = 10000;

/**
 * Class to be used on any emitter error to pass a reason and the current message
 */
class ErrorMessage extends Error {
  constructor(message, status, queueMessage) {
    super(message);
    this.status = status;
    this.queueMessage = queueMessage;
    this.originalAzureError = message;

    if (typeof Error.captureStackTrace === 'function') {
      Error.captureStackTrace(this, this.constructor);
    } else {
      this.stack = (new Error(message)).stack;
    }
  }
}

class DebugMessage {
  /**
   *
   * @param {String} message
   * @param {Object} metadata
   */
  constructor(message, metadata = null) {
    this.message = message;
    this.metadata = metadata;
  }
}

/**
 * Event errors that can be emitted this library
 */

const ON_ERROR_READ_MESSAGE_FROM_AZURE = 'on_error_read_message_from_azure';
const QUEUE_NOT_FOUND = 'queue_not_found';
const ON_UNLOCK_MESSAGE_FROM_AZURE = 'on_unlock_message_from_azure';
const ON_REMOVE_MESSAGE_FROM_AZURE = 'on_remove_unlock_message_from_azure';
const ON_UNLOCK_MESSAGE_FROM_AZURE_MAX_ATTEMPTS = 'on_unlock_message_from_azure_max_attempts';
const ON_DELETE_MESSAGE_FROM_AZURE_MAX_ATTEMPTS = 'on_delete_message_from_azure_max_attempts';
const MAX_THREADS_EXCEEDED = 'max_threads_exceeded';

/**
 * Operational errors (to be used with ErrorMessage)
 */
const AZURE_NO_MESSAGES = 'No messages to receive';

/**
 * The options argument is an object which maps to the retry module options:
 * retries: The maximum amount of times to retry the operation. Default is 10.
 * factor: The exponential factor to use. Default is 2.
 * minTimeout: The number of milliseconds before starting the first retry. Default is 1000.
 * maxTimeout: The maximum number of milliseconds between two retries. Default is Infinity.
 * randomize: Randomizes the timeouts by multiplying with a factor between 1 to 2. Default is false.
 */
const optionRetryPromise = {
  retries: 3,
  maxTimeout: 4000,
};

/**
 * Private methods to be used inside this module
 *  getQueueData
 */
class ServiceBusPrivate {
  constructor(azureServiceBus) {
    this.serviceBus = azureServiceBus;

    this.getQueueData = this.getQueueData.bind(this);
    this.unlockMessage = this.unlockMessage.bind(this);
    this.removeMessage = this.removeMessage.bind(this);
  }

  /**
   * @param {Object} azureBus
   * @param {String} queueName
   * @result {Object} queueData or null
   */
  getQueueData(queueName) {
    return new Promise((resolve, reject) => {
      this.serviceBus.listQueues((err, remoteQueues) => {
        if (err) {
          return reject(err);
        }

        if (!Array.isArray(remoteQueues)) {
          return reject(`remoteQueues is not an array: ${remoteQueues}`);
        }

        const myQueues = remoteQueues.filter((queue) => {
          return queue.QueueName === queueName;
        });

        const myQueue = myQueues.length !== 0 ? myQueues[0] : null;

        return resolve(myQueue);
      });
    });
  }

  unlockMessage(message) {
    return new Promise((resolve, reject) => {
      this.serviceBus.unlockMessage(message, (err, data) => {
        if (err !== null && typeof err === 'object') {
          if (err.code === '404') {
            return reject(new ErrorMessage(err, ON_UNLOCK_MESSAGE_FROM_AZURE, message));
          }
        }

        if (err) {
          return reject(err);
        }

        return resolve(data);
      });
    });
  }

  removeMessage(message) {
    return new Promise((resolve, reject) => {
      this.serviceBus.deleteMessage(message, (err, data) => {
        if (err !== null && typeof err === 'object') {
          if (err.code === '404') {
            return reject(new ErrorMessage(err, ON_REMOVE_MESSAGE_FROM_AZURE, message));
          }
        }

        if (err) {
          return reject(err);
        }

        return resolve(data);
      });
    });
  }
}

class ServiceBusAzureWatcher {
  constructor(azureServiceBus, queueName, concurrency = 1) {
    this.serviceBus = azureServiceBus;
    this.queueName = queueName;
    this.concurrency = concurrency;
    this.onMessageCallback = () => {};

    this.queueData = null;
    this.myEmitter = new EventEmitter();
    this.sbPrivate = new ServiceBusPrivate(this.serviceBus);

    /**
     * state variables to know what action to do in checkConcurrency
     */
    this.isStartRunning = false;
    this.maxThreadsCreated = 0;

    /**
     * stats information
     */
    this.lastReadMessageAt = null;
    this.lastReadMessage = null;
    this.lastReadErrorMessage = null;
    this.lastJobDoneAt = null;
    this.lastJobDone = null;
    this.lastJobErrorDone = null;

    // bind methods
    this.getWatcherInfo = this.getWatcherInfo.bind(this);
    this.start = this.start.bind(this);
    this.startReceivingMessages = this.startReceivingMessages.bind(this);
    this.checkConcurrency = this.checkConcurrency.bind(this);
    this.readOneMessage = this.readOneMessage.bind(this);
    this.onMessage = this.onMessage.bind(this);
    this.onError = this.onError.bind(this);
    this.onDebug = this.onDebug.bind(this);
  }

  getWatcherInfo() {
      return ({
        isStartRunning: this.isStartRunning,
        queueName: this.queueName,
        concurrency: this.concurrency,
        maxThreadsCreated: this.maxThreadsCreated || -2,
        queueData: this.queueData || null,
        currentMessagesInQueue: this.queueData ? (parseInt(this.queueData.CountDetails['d2p1:ActiveMessageCount'], 10) || 0) : -1,
        history: {
          onReadOneMessage: {
            lastReadMessageAt: this.lastReadMessageAt || null,
            lastReadMessage: this.lastReadMessage || null,
            lastReadErrorMessage: this.lastReadErrorMessage || null,
          },
          onJobDone: {
            lastJobDoneAt: this.lastJobDoneAt || null,
            lastJobDone: this.lastJobDone || null,
            lastJobErrorDone: this.lastJobErrorDone || null,
          },
        },
      });
  }

  /**
   * Starts reading pool messages from azure
   * 1. Check if queue exist
   * 2. Start receiving messages
   */
  start() {
    this.sbPrivate.getQueueData(this.queueName).then((queueData) => {
      if (queueData === null) {
        return this.myEmitter.emit('error', new ErrorMessage(`queue not found: ${this.queueName}`, QUEUE_NOT_FOUND, null));
      }

      this.queueData = queueData;

      this.startReceivingMessages();

      setTimeout(() => {
        this.myEmitter.emit('debug', new DebugMessage('starting concurrency checker'));
        this.checkConcurrency();
      }, CHECK_CONCURRENCY_TIMER);
    }).catch((err) => {
      this.myEmitter.emit('error', 'start_error', new ErrorMessage(err, 'start_error', null));
    });
  }

  /**
   * Special method that must be run each X seconds to check if we have enough messages
   * to enable the multi option process (call readOneMessage more than once after), scenario:
   *  1. nodejs run and there is 0 messages in queue
   *  2. node js just run one process to check if there are messages and pass it to user callback
   *  3. then, there are a lot of messages in queue
   *  4. so, it's necessary create max CONCURRENCY process to attendee that requests
   */
  checkConcurrency() {
    if (this.queueData) {
      this.sbPrivate.getQueueData(this.queueName).then((queueData) => {
        if (queueData === null) {
          setTimeout(() => { this.checkConcurrency(); }, CHECK_CONCURRENCY_TIMER);
          return this.myEmitter.emit('error', new ErrorMessage(`queue not found: ${this.queueName}`, QUEUE_NOT_FOUND, null));
        }

        this.queueData = queueData;
        const currentMessagesInQueue = parseInt(queueData.CountDetails['d2p1:ActiveMessageCount'], 10) || 0;
        if (currentMessagesInQueue === 0) {
          setTimeout(() => { this.checkConcurrency(); }, CHECK_CONCURRENCY_TIMER);
          this.maxThreadsCreated = 1;

          return null;
        }

        if (currentMessagesInQueue > this.concurrency && this.maxThreadsCreated < this.concurrency) {
          while (this.maxThreadsCreated < this.concurrency) {
            this.maxThreadsCreated = this.maxThreadsCreated + 1;
            this.readOneMessage();
          }
        } else if (currentMessagesInQueue < this.maxThreadsCreated) {
          this.maxThreadsCreated = currentMessagesInQueue;
        }

        setTimeout(() => { this.checkConcurrency(); }, CHECK_CONCURRENCY_TIMER);
      }).catch((err) => {
        this.myEmitter.emit('error', 'start_error', new ErrorMessage(err, 'start_error', null));

        setTimeout(() => { this.checkConcurrency(); }, CHECK_CONCURRENCY_TIMER);
      });
    }
  }

  /**
   * Start reading max concurrency messages but putting a small delay
   * to avoid network bottle necks in azure
   */
  startReceivingMessages() {
    /**
     * Variables to keep a small delay between request to avoid network bottlenecks
     */
    let delay = 0;
    let i = 0;
    this.isStartRunning = true;
    this.maxThreadsCreated = 0;

    /**
     * If there are no messages in the queue, we tried to read just one message
     * becasue readOneMessage function has a mechanism to lock for new messages
     * each X time
     * 'd2p1:ActiveMessageCount' is the pending messages to be deliver in the queue
     * (no the number of dead letters)
     */
    const currentMessagesInQueue = parseInt(this.queueData.CountDetails['d2p1:ActiveMessageCount'], 10) || 0;

    if (currentMessagesInQueue === 0) {
      this.maxThreadsCreated = this.maxThreadsCreated + 1;
      return this.readOneMessage();
    }

    /**
     * If there are messages, try to read them keeping concurrency and
     * dont create more requests than messages in the queue
     */
    let maxCallsInvoked = -1;
    while (++ maxCallsInvoked < this.concurrency && maxCallsInvoked < currentMessagesInQueue && this.maxThreadsCreated < this.concurrency) {
      this.maxThreadsCreated = this.maxThreadsCreated + 1;
      delay = i + 25;

      setTimeout(() => {
        this.readOneMessage();
      }, delay);
    }

    this.isStartRunning = false;
  }

  readOneMessage() {
    if (this.maxThreadsCreated > this.concurrency) {
      this.maxThreadsCreated = this.concurrency;
      this.myEmitter.emit('error', new ErrorMessage(MAX_THREADS_EXCEEDED, MAX_THREADS_EXCEEDED, null));
      return;
    }

    this.serviceBus.receiveQueueMessage(this.queueName, { isPeekLock: true }, (err, message) => {
      this.lastReadMessageAt = Date.now();
      this.lastReadMessage = message;
      this.lastReadErrorMessage = err;

      if (err === AZURE_NO_MESSAGES) {
        setTimeout(() => {
          return this.readOneMessage();
        }, 500);
        return;
      }

      if (err) {
        this.myEmitter.emit('error', new ErrorMessage(err, ON_ERROR_READ_MESSAGE_FROM_AZURE, message));
        setTimeout(() => {
          return this.readOneMessage();
        }, 500);
        return;
      }

      /**
       * @param {Object} originalMessage Raw message received from Azure Bus Service
       * @return {Function} done Function to be called when the user finish to process the given message to
       *  released it (in case of error) or to delete it (in succesful case)
       */
      const done = ((originalMessage) => {
        this.lastJobDoneAt = Date.now();
        this.lastJobDone = originalMessage;

        return (err) => {
          /**
           * After user finish, if exist some error sent by user, unlock the message to be processed again
           * later by the worker (message will remain in the Azure Bus service)
           */
          if (err) {
            return this.sbPrivate.unlockMessage(originalMessage).then(() => {
              this.readOneMessage();
            }).catch((err) => {
              this.lastJobErrorDone = err;

              /**
               * avoid retry if is a non recoverable error
               * like unlock invalid or message doesnt exist
               * */
              if (err instanceof ErrorMessage) {
                this.myEmitter.emit('error', err);
              }

              this.readOneMessage();
            });
          }

          /**
           * After user finish, if doenst exist any error sent by user, delete the message
           * from Azure Bus Service
           */
          return this.sbPrivate.removeMessage(originalMessage).then((data) => {
            this.readOneMessage();
          }).catch((err) => {
            this.lastJobErrorDone = err;
            // avoid retry if is a well know error
            if (err instanceof ErrorMessage) {
              this.myEmitter.emit('error', err);
            }

            this.readOneMessage();
          });
        };
      })(message);

      this.onMessageCallback(message, done);
    });
  }

  /**
   * Mehtod to be invoked after a message received
   * @param {Function} callback
   */
  onMessage(callback) {
    this.onMessageCallback = callback;
  }

  onError(callback) {
    this.myEmitter.on('error', callback);
  }

  onDebug(callback) {
    this.myEmitter.on('debug', callback);
  }
}

module.exports = ServiceBusAzureWatcher;
