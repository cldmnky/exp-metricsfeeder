"use strict";
var _ = require("lodash");
var dns = require('native-dns');
var util = require('util');
var os = require('os')
var EventEmitter = require("events").EventEmitter;
if (os.platform() == 'linux') {
  var monitr = require('monitr');
}
var dgram = require('unix-dgram');
var fs = require('fs');
var dummyLogger = require("./lib/dummyLogger");
var statsdClient = require('node-statsd-client').Client;

var config;
var intervalObj;
var server;
var initTime;
var emitter;
var logger;

var start = Date.now();


var Metrics = function(options) {
  var self = this;
  logger = options.logger || dummyLogger();
  initTime = new Date().getTime();
  logger.debug("exp-metricsfeeder starting");
  if (!options || !options.appName) {
    throw new Error("You must supply an appName");
  }
  options = _.defaults(options, {
    useResolver: false,
    resolver: "127.0.0.1:8600",
    resolverProto: "tcp",
    domain: "service.consul",
    statsd: "127.0.0.1:8192",
    pushInterval: 2000,
    basePath: "/tmp/",
    hostname: os.hostname().split('.').shift(),
    monPath: false,
    started: false
  });
  config = options;
  config.monPath = getPath() + filePrefix() + process.pid + ".sock"
  process.on('uncaughtException', function (err) {
    console.log(err);
    return;
  });
  resolveStatsD(function (err, answer) {
    if (answer) {
      var statsdPort = answer.answer[0].port
      var statsdIP = answer.additional[0].address
      config.statsd = statsdIP + ":" + statsdPort
    }
  });
  try {
    ensurePath();
  } catch (ex) {
    return;
  }
  var monitorSocket = dgram.createSocket('unix_dgram');
  socketBind(monitorSocket);
  var stats = null;
  monitorSocket.on('message', function (msg, rinfo) {
    stats = JSON.parse(msg.toString());
    self.emit('stats', stats);
  });
  var runMonitr = startMonitr()
  setTimeout(function(){
    console.log("Starting metricsfeeder for " + config.appName + ", feeding stats to: statsd://" + config.statsd)
    self.emit('metricsfeederStarted')
    self.client = new statsdClient(config.statsd.split(':')[0], config.statsd.split(':')[1]);
  }, 2000);

  // methods
  this.count = function(name, counter, mtype) {
    if (typeof mtype === 'undefined') {
      mtype = "application"
    }
    self.emit('count', 'metricsfeeder.' + mtype + '.' + config.hostname + '.' + config.appName + '.' + name, counter);
  }

  this.gauge = function(name, gauge, mtype) {
    if (typeof mtype === 'undefined') {
      mtype = "application"
    }
    self.emit('gauge', 'metricsfeeder.' + mtype + '.' + config.hostname + '.' + config.appName + '.' + name, gauge);
  }

  this.timing = function(name, timing, mtype) {
    if (typeof mtype === 'undefined') {
      mtype = "application"
    }
    self.emit('timing', 'metricsfeeder.' + mtype + '.' + config.hostname + '.' + config.appName + '.' + name, timing);
  }
  // events

  self.on('stats', function(stats){
    var monitrGauges = ['cpu', 'user_cpu', 'sys_cpu', 'cpuperreq', 'jiffyperreq', 'mem',
                        'oreqs', 'rps', 'kbs_out', 'kb_trans', 'oconns', 'reqstotal'];
    var monitrCounters = [];
    var monitrTimings = ['elapsed'];
    var monitrObj = ['gc']
    Object.keys(stats.status).forEach(function(key){
      if (monitrGauges.indexOf(key) > -1) {
        self.gauge(key, stats.status[key], 'monitr');
      };
      if (monitrCounters.indexOf(key) > -1) {
        self.count(key, stats.status[key], 'monitr');
      };
      if (monitrTimings.indexOf(key) > -1) {
        self.timing(key, stats.status[key], 'monitr');
      };
      if (monitrObj.indexOf(key) > -1) {
        Object.keys(stats.status.gc).forEach(function(gctype){
          self.gauge(key + '-' + gctype + '_count', stats.status.gc[gctype].count, 'monitr');
          self.timing(key + '-' + gctype + '_elapsed_ms', stats.status.gc[gctype].elapsed_ms, 'monitr');
          self.timing(key + '-' + gctype + '_max_ms', stats.status.gc[gctype].max_ms, 'monitr');
        })
      }
    });
  });

  self.on('count', function(name, counter) {
    if (config.started) {
      self.client.count(name, counter);
    }
  });

  self.on('gauge', function(name, gauge) {
    if (config.started) {
      self.client.gauge(name, gauge);
    }
  });

  self.on('timing', function(name, timing) {
    if (config.started) {
      self.client.timing(name, timing);
    }
  });

  self.once('metricsfeederStarted', function(){
    config.started = true;
  });
}

function socketBind(monitorSocket) {
  fs.unlink(config.monPath, function () {
    var  um = process.umask(0);
      // Bind to the socket and start listening the stats
      monitorSocket.bind(config.monPath);
      setTimeout(function () {
        try {
              fs.chmodSync(config.monPath, 511); //0777
            } catch (e) {
              console.log("ERROR: Could not change mod for Socket" + e.stack);
            }
          }, 500);
      process.umask(um);
    });
}

function filePrefix() {
  return util.format("exp-metricsfeeder-%s-", config.appName);
}

function getPath() {
  var basePath = config.basePath;
  if (basePath[basePath.length - 1] !== "/") {
    basePath += "/";
  }
  return config.basePath + config.appName + "/";
}

function ensurePath() {
  var path = getPath();
  if (!fs.existsSync(path)) {
    try {
      fs.mkdirSync(path);
    } catch (ex) {
      logger.error("Unable to create path %s", path);
      throw ex;
    }
  }
}

function startMonitr() {
  if (os.platform() == 'linux') {
    monitr.setIpcMonitorPath(getPath() + filePrefix() + process.pid + ".sock");
    try {
      monitr.start()
      return true;
    } catch (ex) {
      return false;
    }
  }
  return false;
}

function resolveStatsD(cb) {
  if (config.useResolver) {
    // try to use the resolver
    var srv_question = dns.Question({
      name: '_statsd._udp.' + config.domain,
      type: 'SRV',
    });
    var req = dns.Request({
      question: srv_question,
      server: {
        address: config.resolver.split(':')[0],
        port: config.resolver.split(':')[1],
        type: config.resolverProto },
      timeout: 1000,
    });
    req.on('message', cb);
    req.on('timeout', cb);
    req.send();
  }
}

/*
 * stop monitoring
 */
 process.on('exit', function () {
   console.log('exit');
   if (os.platform () == 'linux'){
    monitr.stop();
  }
});

// Graceful shutdown
process.on('SIGINT', function () {
   process.exit();
});


util.inherits(Metrics, EventEmitter);
module.exports = Metrics;


// var Metrics = require('exp-metricsfeeder');
// var metrics = new Metrics({appName: 'my_App', statsd: '10.200.1.65:9125'});
// setInterval(function() {
//   metrics.count('mycounter', 3)
// }, 1000);
// setInterval(function() {
//   metrics.gauge('mygauge', 3)
// }, 1000);
// metrics.gauge("my_gauge", 3);
// metrics.timing('request_ms', 200);
// metrics.count('active_users', 12);
