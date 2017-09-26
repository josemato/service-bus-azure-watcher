Service Bus Azure Watcher
===========================

Small library to help handle Azure Service Bus messages

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
