const os = require('os');
const jwt = require('jsonwebtoken');
const http = require('http')
const https = require('https')
const morgan = require('morgan');
const express = require('express')
const concat = require('concat-stream');
const { promisify } = require('util');
const promBundle = require("express-prom-bundle");

const {
  PROMETHEUS_ENABLED = false,
  PROMETHEUS_METRICS_PATH = '/metrics',
  PROMETHEUS_WITH_PATH = false,
  PROMETHEUS_WITH_METHOD = 'true',
  PROMETHEUS_WITH_STATUS = 'true',
  PROMETHEUS_METRIC_TYPE = 'summary',
} = process.env

const sleep = promisify(setTimeout);
const metricsMiddleware = promBundle({
  metricsPath: PROMETHEUS_METRICS_PATH,
  includePath: (PROMETHEUS_WITH_PATH == 'true'),
  includeMethod: (PROMETHEUS_WITH_METHOD == 'true'),
  includeStatusCode: (PROMETHEUS_WITH_STATUS == 'true'),
  metricType: PROMETHEUS_METRIC_TYPE,
});

const app = express()
app.set('json spaces', 2);
app.set('trust proxy', ['loopback', 'linklocal', 'uniquelocal']);

if(PROMETHEUS_ENABLED === 'true') {
  app.use(metricsMiddleware);
}

if(process.env.DISABLE_REQUEST_LOGS !== 'true'){
  app.use(morgan('combined'));
}

app.use(function(req, res, next){
  req.pipe(concat(function(data){
    req.body = data.toString('utf8');
    next();
  }));
});

//Handle all paths
app.all('*', (req, res) => {
  const echo = {
    path: req.path,
    headers: req.headers,
    method: req.method,
    body: req.body,
    cookies: req.cookies,
    fresh: req.fresh,
    hostname: req.hostname,
    ip: req.ip,
    ips: req.ips,
    protocol: req.protocol,
    query: req.query,
    subdomains: req.subdomains,
    xhr: req.xhr,
    os: {
      hostname: os.hostname()
    },
    connection: {
      servername: req.connection.servername
    }
  };

  //Add client certificate details to the output, if present
  //This only works if `requestCert` is true when starting the server.
  if(req.socket.getPeerCertificate){
    echo.clientCertificate = req.socket.getPeerCertificate();
  }

  //Include visible environment variables
  if(process.env.ECHO_INCLUDE_ENV_VARS){
    echo.env = process.env;
  }

  //If the Content-Type of the incoming body `is` JSON, it can be parsed and returned in the body
  if(req.is('application/json')){
    echo.json = JSON.parse(req.body)
  }

  //If there's a JWT header, parse it and decode and put it in the response
  if (process.env.JWT_HEADER) {
    let token = req.headers[process.env.JWT_HEADER.toLowerCase()];
    if (!token) {
      echo.jwt = token;
    } else {
      token = token.split(" ").pop();
      const decoded = jwt.decode(token, {complete: true});
      echo.jwt = decoded;
    }
  }

  //Set the status code to what the user wants
  const setResponseStatusCode = parseInt(req.headers["x-set-response-status-code"] || req.query["x-set-response-status-code"], 10)
  if (100 <= setResponseStatusCode && setResponseStatusCode < 600) {
    res.status(setResponseStatusCode)
  }

  //Delay the response for a user defined time
  const sleepTime = parseInt(req.headers["x-set-response-delay-ms"] || req.query["x-set-response-delay-ms"], 0)
  sleep(sleepTime).then(() => {

    //Set the response content type to what the user wants
    const setResponseContentType = req.headers["x-set-response-content-type"] || req.query["x-set-response-content-type"];

    if(setResponseContentType){
      res.contentType(setResponseContentType);
    }

    //Ability to send an empty response back
    if (process.env.ECHO_BACK_TO_CLIENT != undefined && process.env.ECHO_BACK_TO_CLIENT == "false"){
      res.end();
    }
    //Ability to send just the request body in the response, nothing else
    else if ("response_body_only" in req.query && req.query["response_body_only"] == "true") {
      res.send(req.body);
    }
    //Normal behavior, send everything back
    else {
      res.json(echo);
    }

    //Certain paths can be ignored in the container logs, useful to reduce noise from healthchecks
    if (process.env.LOG_IGNORE_PATH != req.path) {

      let spacer = 4;
      if(process.env.LOG_WITHOUT_NEWLINE) {
        spacer = null;
      }

      //Allow logging to standard error if the status code is a failure
      let loggerFunction = console.log;
      if (process.env.LOG_TO_STANDARD_ERROR === "true" && setResponseStatusCode >= 400 && setResponseStatusCode < 600) {
        loggerFunction = console.error;
      }

      loggerFunction(JSON.stringify(echo, null, spacer));
    }
  });


});

let sslOpts = {
  key: require('fs').readFileSync(process.env.HTTPS_KEY_FILE || 'privkey.pem'),
  cert: require('fs').readFileSync(process.env.HTTPS_CERT_FILE || 'fullchain.pem')
};

//Whether to enable the client certificate feature
if(process.env.MTLS_ENABLE){
    sslOpts = {
      requestCert: true,
      rejectUnauthorized: false,
      ...sslOpts
    }
}

var httpServer = http.createServer(app).listen(process.env.HTTP_PORT || 8080);
var httpsServer = https.createServer(sslOpts,app).listen(process.env.HTTPS_PORT || 8443);
console.log(`Listening on ports ${process.env.HTTP_PORT || 8080} for http, and ${process.env.HTTPS_PORT || 8443} for https.`);

let calledClose = false;

process.on('exit', function () {
  if (calledClose) return;
  console.log('Got exit event. Trying to stop Express server.');
  server.close(function() {
    console.log("Express server closed");
  });
});

process.on('SIGINT', shutDown);
process.on('SIGTERM', shutDown);

function shutDown(){
  console.log('Got a kill signal. Trying to exit gracefully.');
  calledClose = true;
  httpServer.close(function() {
    httpsServer.close(function() {
      console.log("HTTP and HTTPS servers closed. Asking process to exit.");
      process.exit()
    });
  });
}
