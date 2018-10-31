'use strict';
const fs = require('fs');
const http = require('http');  // const https = require('https');
const WebSocket = require('ws');
const settings = require('./settings.json');


/**
 * Log an Error Message; Optionally simplify the output
 * @param {Error} err - an error Object that was thrown
 * @param {String} [seperator=" --> "] - a string used to seperate parts of the error ourput
 * @param {String} [preMessage="\n***${date}***"] - a string that is prepended to each error message
 * @param {Boolean | String} [simplify] - if true, the output will be shortened and will not include the lengthy stack trace data; if a String is recieved for the simplify parameter, the error message will be replaced with the String; if the err Object includes a custom "simpleMessage" property (whether or not the simplify paramter is true), the simpleMessage property will be used without lengthy trace info
 */
function logErr(err, seperator, preMessage, simplify) {
	if (!seperator) seperator = ' --> ';
	if (!preMessage) preMessage = '\n*** ' + new Date().toLocaleString() + ' ***  ';
	if (simplify && typeof(simplify) === 'string') console.warn(preMessage + simplify);
	else if (err.simpleMessage) console.warn(preMessage + err.simpleMessage);
	else console.warn(preMessage + err.message + (simplify ? '' : seperator + err.stack));
}

/**
 * Fetch JSON or other data from a given url and return the result (as a promise)
 * @param {string} url - the url to fetch
 * @param {number} [timeoutMs] - milliseconds to wait before timing out. If not specified, will not timeout.
 * @param {string} [name] - short name of the website from which to fetch (for error handling only)
 * @returns {Promise} Returned data from the url. If JSON was returned, it will be parsed into an Object. Otherwise, as a string.
 */
 function fetchWebDta (url, timeoutMs, name) {
	return new Promise((resolve, reject) => {
		if (timeoutMs) setTimeout(() => {
			let err = new Error('Error in fetchWebDta(): Timeout fetching ' + url);
			err.simpleMessage = 'fetchWebDta(): timeout fetching from ' + (name || '-unspecified-');
			reject(err);
		}, timeoutMs);
		https.get(url, resp => {
			let dta = '';
			resp.on('error', err => { err.message = 'Error in fetchWebDta(' + url + '): ' + err.message; reject(err); });
			resp.on('data', chunk => dta += chunk);
			resp.on('end', () => {
				try { resolve(JSON.parse(dta)); }
				catch (err) { resolve(dta); }
			});
		})
	})
}

/**
 * Take a list of links and return unrestricted Links from real debrid
 * @param {Object} ws - the websocket on which to send updated endpoint data
 * @param {Object} msg - the link data list of links in the form {links: ["link", "link", "link"], linksPw: "passwd", saveLoc: "/path/to/save"}
 */
function sbmtLinks(ws, msg) {
	for (const pointName of Object.keys(settings.endPoints)) {
		if (sendExsistingFirst) wsSendPoint(ws, null, settings.endPoints[pointName], 'Error from updateEndPoints() updating ' + pointName + ': '); // send existing data immediatly
		endpointTick(settings.endPoints[pointName], ws);
	}
}


/**
 * Entry Point
 */
const server = http.createServer();
server.filesCache = {
	"pageTemplate.html": {"path": "./pageTemplate.html", "head": { "Content-Type": "text/html" }},
	"bootstrap.min.css": {"path": "./bootstrap.min.css", "head": { "Content-Type": "text/css" }},
	"clientScript.js": {"path": "./clientScript.js", "head": { "Content-Type": "text/javascript" }}
};
for (const fileName of Object.keys(server.filesCache)) {
	fs.readFile(server.filesCache[fileName].path, function(err, data) {
		if (err) { err.message = 'fs error getting file ' + fileName + ': ' + err.message; return logErr(err); throw(err); }
		else server.filesCache[fileName].contents = data;
	});	
}
server.on('request', (request, response) => {
	try {
		let fileName = path.basename(request.url);
		if (request.url.endsWith('/') || fileName === '' || fileName === 'index.html' || fileName === 'index.htm') fileName = 'pageTemplate.html';
		if (server.filesCache[fileName]) {
			response.writeHead(200, server.filesCache[fileName].head);
			response.end(server.filesCache[fileName].contents);		
		} else {
			logErr(new Error('Client requested a file not in server.filesCache: "' + request.url + '" (parsed to filename: ' + fileName + ')'));
			response.writeHead(404, {"Content-Type": "text/plain"});
			response.end('404 Not Found\n');	
		}
	} catch(err) { err.message = 'Error in server.on("request") for url ' + request.url + ': ' + err.message; logErr(err); }
});
server.listen(settings.server.port, err => {
	if (err) { err.message = 'Server Error: ' + err.message; return logErr(err); }
	else {
		const wss = new WebSocket.Server({server});
		wss.on('connection', ws => {
			function closeWs(ws, err) {
				if (err && !err.message.includes('CLOSED')) console.warn('pingTimer error: ' + err.toString() + '\n' + err.stack);
				clearInterval(ws.pingTimer);
				return ws.terminate();
			}
			ws.isAlive = true;
			ws.on('message', message => sbmtLinks(ws, JSON.parse(message)));
			ws.on('pong', () => ws.isAlive = true);
			ws.pingTimer = setInterval(() => {
				if (ws.isAlive === false) return closeWs(ws);
				ws.isAlive = false;
				ws.ping(err => { if (err) return closeWs(ws, err); });
			}, settings.server.pingInterval);
		});
		console.log('Server ' + settings.server.name + ' (http' + (settings.server.https ? 's://' : '://') + settings.server.address + ') is listening on port ' + settings.server.port);
	}
});
