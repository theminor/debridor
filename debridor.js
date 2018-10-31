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
 * Send a data point on the given websocket
 * @param {Object} [ws] - the websocket object. If not specified, nothing is sent
 * @param {Object} [wss] - the full set of ws clients (in which case, it will update all clients on tick)
 * @param {Object} point - the point to send
 * @param {String} errMsg - pre-error message to identify errors by
 */
function wsSendPoint(ws, wss, point, errMsg) {
	if (wss) wss.clients.forEach(ws => wsSendPoint(ws, null, point, 'From wsSendPoint(): '));
	if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(point, (k, v) => (k === 'mqttClient' || k === 'timer') ? undefined : v), err => { if (err) { err.message = 'Websocket Send Error: ' + errMsg + ': ' + err.message; logErr(err); } });
}

/**
 * Return the value of a deep Object location given as a string referenceing that location (see https://stackoverflow.com/questions/42206967/getting-a-field-from-a-json-object-using-a-address-string-in-javascript)
 * @param {Object} obj - the object to analyze
 * @param {string} pathString - a string referencing the path to the deep object wanted to return
 * @returns {Object} the referenced item
 * @example
 * // returns "hi"
 * getValue({foo:{x:0,data:[bar:"hi", baz:"no"]}}, foo.data[0].bar);
 */
function getValue(obj, pathString) {
	let valStg = pathString.replace(/\[/g, '.').replace(/\]/g, '').replace(/\"/g, '').replace(/\'/g, '').split('.').reduce((obj, key) => (obj || {})[key], obj);
	return isNaN(valStg) ? valStg : Number(valStg);
}

/**
 * Update an endpoint and send endpoint data to the given websocket
 * @param {Object} point - object containing the settings for the endpoint
 * @param {Object} [ws] - the websocket on which to send data
 * @param {Object} [wss] - the full set of ws clients (in which case, it will update all clients on tick)
 */
async function endpointTick(point, ws, wss) {
	try {
		let rawDta;
		if (point.socket) rawDta = await fetchSocket(point.socket.url, point.socket.port, point.socket.netCmnd, point.dataTimeoutMS);
		else if (point.web) rawDta = await fetchWebDta(point.web.url, point.dataTimeoutMS, point.name);
		else if (point.mqtt) return await setupMqtt(point, ws, wss);
		point.lastData = { "raw": rawDta };
		for (const key of Object.keys(point.variableData)) {
			if (point.variableData[key].findRange) {
				let ldr;
				for (let i = point.variableData[key].pathRangeMin; i < point.variableData[key].pathRangeMax; i++) {
					let curVal = getValue(rawDta, point.variableData[key].path.replace('?', i));
					if (!ldr || (point.variableData[key].findRange === 'max' && curVal > ldr) || (point.variableData[key].findRange === 'min' && curVal < ldr)) ldr = curVal;
				}
				point.lastData[key] = (ldr * (point.variableData[key].multiplier || 1)) + (point.variableData[key].offset || 0);
			} else {
				let dta = getValue(rawDta, point.variableData[key].path);
				point.lastData[key] = isNaN(dta) ? dta : (getValue(rawDta, point.variableData[key].path) * (point.variableData[key].multiplier || 1)) + (point.variableData[key].offset || 0);
			}
			copyLastDataToHistory(point, key);
			if (point.variableData[key].calculateRangePercent) {
				if (!point.variableData[key].rangeMin || point.lastData[key] < point.variableData[key].rangeMin) point.variableData[key].rangeMin = point.lastData[key];
				if (!point.variableData[key].rangeMax || point.lastData[key] > point.variableData[key].rangeMax) point.variableData[key].rangeMax = point.lastData[key];
			}
			if ((point.variableData[key].notification && point.variableData[key].notification.lowThreshold && (point.lastData[key] <= point.variableData[key].notification.lowThreshold)) ||(point.variableData[key].notification && point.variableData[key].notification.highThreshold && (point.lastData[key] >= point.variableData[key].notification.highThreshold))) sendNotification(point.variableData[key].notification);
		}
		wsSendPoint(ws, wss, point, 'From endpointTick(): ');
	} catch(err) { err.message = 'Error in endpointTick(' + point.name + '): ' + err.message; logErr(err); }
	if (point.updateAfter) endpointTick(settings.endPoints[point.updateAfter], ws, wss);
}

/**
 * Update all endpoints and send updated data to the given websocket
 * @param {Object} ws - the websocket on which to send updated endpoint data
 */
function updateEndPoints(ws, sendExsistingFirst) {
	for (const pointName of Object.keys(settings.endPoints)) {
		if (sendExsistingFirst) wsSendPoint(ws, null, settings.endPoints[pointName], 'Error from updateEndPoints() updating ' + pointName + ': '); // send existing data immediatly
		endpointTick(settings.endPoints[pointName], ws);
	}
}

/**
 * Update all endpoints and send updated data to the given websocket
 * @param {Object} ws - the websocket on which to send updated endpoint data
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
			ws.on('message', message => sbmtLinks(ws, message));
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
