var inherits = require('util').inherits
  , f = require('util').format
  , EventEmitter = require('events').EventEmitter
  , Pool = require('../connection/pool')
  , b = require('bson')
  , Query = require('../connection/commands').Query
  , MongoError = require('../error')
  , BSON = require('bson').native().BSON;

// All bson types
var bsonTypes = [b.Long, b.ObjectID, b.Binary, b.Code, b.DBRef, b.Symbol, b.Double, b.Timestamp, b.MaxKey, b.MinKey];

// Single store for all callbacks
var Callbacks = function() {
  EventEmitter.call(callbacks);  
}
inherits(Callbacks, EventEmitter);

var callbacks = new Callbacks;

/**
 * Server implementation
 */
var Server = function(options) {
  var self = this;
  // Add event listener
  EventEmitter.call(this);
  // Reconnect option
  var reconnect = options.reconnect || true;
  var reconnectTries = options.reconnectTries || 30;
  var reconnectInterval = options.reconnectInterval || 1000;
  // Current state
  var currentReconnectRetry = reconnectTries;

  // Let's get the bson parser if none is passed in
  if(options.bson == null) {
    options.bson = new BSON(bsonTypes);
  }

  // Save bson
  var bson = options.bson;

  // Internal connection pool
  var pool = new Pool(options);

  //
  // Reconnect server
  var reconnectServer = function() {
    currentReconnectRetry = reconnectTries;
    // Create a new Pool
    pool = new Pool(options);
    // error handler
    var errorHandler = function() {
      // Destroy the pool
      pool.destroy();
      // Adjust the number of retries
      currentReconnectRetry = currentReconnectRetry - 1;
      // No more retries
      if(currentReconnectRetry <= 0) {
        self.emit('error', f('failed to connect to %s:%s after %s retries', options.host, options.port, reconnectTries));
      } else {
        setTimeout(function() {
          reconnectServer();
        }, reconnectInterval);
      }
    }

    //
    // Attempt to connect
    pool.once('connect', function() {
      // Remove any non used handlers
      pool.removeAllListeners('error');
      pool.removeAllListeners('close');
      pool.removeAllListeners('timeout');

      // Add proper handlers
      pool.on('error', errorHandler);
      pool.on('close', closeHandler);
      pool.on('timeout', timeoutHandler);
      pool.on('message', messageHandler);
    });

    //
    // Handle connection failure
    pool.once('error', errorHandler);
    pool.once('close', errorHandler);
    pool.once('timeout', errorHandler);

    // Connect pool
    pool.connect();
  }

  //
  // Handlers
  var messageHandler = function(response, connection) {    
    var docs = response.documents;
    console.dir("============================================")
    console.dir(docs)
    // Single document response
    if(docs.length == 1) {
      callbacks.emit(response.responseTo, null, docs[0]);
    }

    // Multiple document responses
    callbacks.emit(response.responseTo, null, response.documents);
  }

  var errorHandler = function(err, connection) {
    self.destroy();
    // console.dir(err)
    self.emit('error', err, self);
    if(reconnect) reconnectServer();
  }

  var timeoutHandler = function(err, connection) {
    self.destroy();
    self.emit('timeout', err, self);
    if(reconnect) reconnectServer();
  }

  var closeHandler = function(err, connection) {
    self.destroy();
    self.emit('close', err, self);
    if(reconnect) reconnectServer();
  }

  var connectHandler = function(connection) {
    self.emit("connect", self);
  }

  // connect
  this.connect = function() {
    // Connect the pool
    pool.connect(); 
    // Add all the event handlers
    pool.on('timeout', timeoutHandler);
    pool.on('close', closeHandler);
    pool.on('error', errorHandler);
    pool.on('message', messageHandler);
    pool.on('connect', connectHandler);
  }

  // destroy the server instance
  this.destroy = function() {
    // Destroy all event emitters
    ["close", "message", "error", "timeout", "connect"].forEach(function(e) {
      pool.removeAllListeners(e);
    });

    // Close pool
    pool.destroy();
  }

  // is the server connected
  this.isConnected = function() {
    if(pool) return pool.isConnected();
    return false;
  }

  //
  // Execute a write operation
  var executeWrite = function(self, type, opsField, ns, ops, options, callback) {
    if(ops.length == 0) throw new MongoError("insert must contain at least one document");
    if(typeof options == 'function') {
      callback = options;
      options = {};
    }

    // Split the ns up to get db and collection
    var p = ns.split(".");
    // Options
    var ordered = options.ordered || true;
    var writeConcern = options.writeConcern || {};
    // return skeleton
    var writeCommand = {};
    writeCommand[type] = p[1];
    writeCommand[opsField] = ops;
    writeCommand.ordered = ordered;
    writeCommand.writeConcern = writeConcern;
    // Execute command
    self.command(f("%s.$cmd", p[0]), writeCommand, {}, callback);    
  }

  // Execute a command
  this.command = function(ns, cmd, options, callback) {
    if(typeof options == 'function') {
      callback = options;
      options = {};
    }
    
    // Ensure we have no options
    options = options || {};
    // Create a query instance
    var query = new Query(bson, ns, cmd, {
      numberToSkip: 0, numberToReturn: -1
    });

    // Set slave OK
    query.slave = slaveOk(options.readPreference);    
    // Register the callback
    callbacks.once(query.requestId, callback);
    // Execute the query
    pool.get().write(query);
  }

  // Execute a write
  this.insert = function(ns, ops, options, callback) {
    executeWrite(this, 'insert', 'documents', ns, ops, options, callback);
  }

  // Execute a write
  this.update = function(ns, ops, options, callback) {
    executeWrite(this, 'update', 'updates', ns, ops, options, callback);
  }

  // Execute a write
  this.remove = function(ns, ops, options, callback) {
    executeWrite(this, 'delete', 'deletes', ns, ops, options, callback);
  }

  // Execute a cursor
  this.find = function(ns, cmd, options, callback) {
    // Support two types of commands (find and aggregate)
    if(cmd.find) {

    } else if(cmd.aggregate) {

    } else {
      throw new Error("command not supported");
    }
  }

  var slaveOk = function(r) {
    if(r == 'secondary' || r =='secondaryPreferred') return true;
    return false;
  }
}

inherits(Server, EventEmitter);

module.exports = Server;