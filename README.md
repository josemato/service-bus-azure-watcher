Service Bus Azure Watcher
===========================

Small library to help handle Azure Service Bus queue messages using azure peek message strategy.
This library retrieves a max number of messages (specified in concurrency variable) and perform next flow:

## How this library works

1. Read message from Azure Service Bus
2. Pass message to user callback function
3. User function is being executed and can goes well or fail
    3.1 user function calls done() to indicate a successful operation (processing the message)
    3.2 user function calls done(err) to indicate a failure operation
4. If user function goes well, the library will delete the message
5. If user function goes wrong, the library will release the message to be available later

Some problems can occur in the process of retrieve message, delete message or release message (unlock):
* Unexpected but common errors: specially network problems like unreach server, connection reset, etc
* Expected errors: Logical errors like tyring to delete a message using an expired lock id (depending on azure configuration "Lock duration")

## Handle errors emitter by the library

For network problem, this library will try to perform the call 3 times before emit an error.

To catch this errors, this library provide by an error listener which can tell us what happened. For any kind of error, this library will provide us an ErrorMessage object given us next attributes: status, message and queueMessage.

Here, we can see the available error status messages (err.status):

* on_error_read_message_from_azure (cause by network problems)
* queue_not_found
* on_unlock_message_from_azure
* on_remove_unlock_message_from_azure
* on_unlock_message_from_azure_max_attempts
* on_delete_message_from_azure_max_attempts

In next versions, error messages will increase to have better knowledge about what is happening.
## Performance benefits

To avoid call Azure Service Bus if there is no messages, user concurrency can be modified dynamically. This happens when all messages were delivered and processed, so, concurrency will be decreased to one and there is an internal checker to see if there are more messages to increase the concurrency according to that but never without pass the limit specified initially by the user. 

## Installation

  `npm install service-bus-azure-watcher`

## ServiceBusWatcher initialization

Constructor of ```ServiceBusWatcher``` needs:
* serviceBus: an azure serviceBusService
* queueName: The name of the queue where to retrieve the messages
* concurrency: Max simultaneous messages to be handle

## Usage
```javascript
const azure = require('azure');
const ServiceBusAzureWatcher = require('service-bus-azure-watcher');

const AZURE_SERVICE_BUS_KEY = 'YOUR_SERVICE_BUS_CONNECTION_STRING';
const QUEUE_NAME = 'YOUR_QUEUE_NAME';
const CONCURRENCY = 50;

const retryOperations = new azure.ExponentialRetryPolicyFilter();
const serviceBus = azure.createServiceBusService(AZURE_SERVICE_BUS_KEY).withFilter(retryOperations);
const myServiceBusWather = new ServiceBusAzureWatcher(serviceBus, QUEUE_NAME, CONCURRENCY);

/**
* User function that process a message. When finish, it's necessary to notify "done" function.
* This "done" function allow one error parameter to indicate user operation failed.
* @param {Object} message Azure message
* @param {Function} done callback function to notify service bus
*  watcher that user finished to process the message
* */
myServiceBusWather.onMessage((message, done) => {
    console.log('received message', message.body);
    done();
    // if user operation failed, you need to call done('some problem') or done(new Error('some problem'))
});

/**
* @param {Object} err This error is an instace of ErrorMessage:
*  stack, error message, status and queueMessage (undefined by default) are available
* */
myServiceBusWather.onError((err) => {
    console.log('user function onError', err.message, err.status, err.queueMessage);
});

myServiceBusWather.start();
````
