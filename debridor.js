'use strict';
const fs = require('fs');
const http = require('http');  // const https = require('https');
const WebSocket = require('ws');
const path = require('path');
const settings = require('./settings.json');


/**
 * Log an Error Message; Optionally simplify the output
 * @param {Error} err - an error Object that was thrown
 * @param {String} [seperator=" --> "] - a string used to seperate parts of the error ourput
 * @param {String} [preMessage="\n***${date}***"] - a string that is prepended to each error message
 * @param {Boolean | String} [simplify=false] - if true, the output will be shortened and will not include the lengthy stack trace data; if a String is recieved for the simplify parameter, the error message will be replaced with the String; if the err Object includes a custom "simpleMessage" property (whether or not the simplify paramter is true), the simpleMessage property will be used without lengthy trace info
 */
function logErr(err, seperator, preMessage, simplify) {
	if (!seperator) seperator = ' --> ';
	if (!preMessage) preMessage = '\n*** ' + new Date().toLocaleString() + ' ***  ';
	if (simplify && typeof(simplify) === 'string') console.warn(preMessage + simplify);
	else if (err.simpleMessage) console.warn(preMessage + err.simpleMessage);
	else console.warn(preMessage + err.message + (simplify ? '' : seperator + err.stack));
}

/**
 * Make a web request and return the retrieved JSON or other data (as a promise)
 * @param {string} url - the url to fetch
 * @param {Object} options - the request options (see http.request options in node.js api)
 * @param {string} [name=url] - short name of the request (for error handling only)
 * @param {string} [saveLoc] - file name with path specifying where to save teh downloaded file. If not specified, the file is not saved and is just returned.
 * @param {Function} [progressFunc] - a function that is called after each chunk is recieved - sole parameter is an object like this: {downloaded: number, totalSize: number}
 * @returns {Promise} Returned data. If JSON was returned, the Promise will resolve into an Object. Otherwise, as a string. If saveLoc is specified, this will instead return a string specifying the saved file location
 */
function fetchWebDta(url, options, name, saveLoc, progressFunc) {
	return new Promise((resolve, reject) => {
		let req = http.request(url, options, (res) => {
			res.on('error', err => { err.message = 'Error in fetchWebDta(' + url + '): ' + err.message; reject(err); });
			let dta = '';
			let responseSize = parseInt(res.headers['content-length'], 10);
            let currentSize = 0;
			let file = false;
			if (saveLoc) {
				file = fs.createWriteStream(saveLoc);
				res.pipe(file)
			} else {
				res.on('data', chunk => {
					dta += chunk;
					currentSize += chunk.length;
					if (progressFunc) progressFunc({downloaded: currentSize, totalSize: responseSize});
				});
			}
			res.on('end', () => {
				if (file) {
					resolve(saveLoc)
				} else {
					try { resolve(JSON.parse(dta)); }
					catch (err) { resolve(dta); }
				}
			});			
		});
		req.on('timeout', () => {
			let err = new Error('Error in fetchWebDta(): Timeout requesting ' + url);
			err.simpleMessage = 'fetchWebDta(): timeout fetching from ' + (name || url);
			reject(err);
		});
	});
}

/**
 * Send a data on the given websocket
 * @param {Object} [ws] - the websocket object. If not specified, nothing is sent
 * @param {Object} [wss] - the full set of ws clients (in which case, it will update all clients)
 * @param {Object} dta - the data to send
 * @param {String} errMsg - pre-error message to identify errors by
 */
function wsSendData(ws, wss, dta, errMsg) {
	if (wss) wss.clients.forEach(ws => wsSendPoint(ws, null, dta, 'From wsSendPoint(): '));
	if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(dta), err => { if (err) { err.message = 'Websocket Send Error: ' + errMsg + ': ' + err.message; logErr(err); } });
}

/**
 * Handle a link
 * @param {Object} ws - the websocket on which to send updated endpoint data
 * @param {Object} wss - the full set of ws clients
 * @param {String} url - the link to handle
 * @param {String} [saveDir] - the base directory in which to save the file (for example "/home/user/downloads/"). If not specified, the 
 */
async function handleLink(ws, wss, url, saveDir) {	
	return await fetchWebDta(url, {timeout: settings.debridAccount.requestTimeout}, null, (dta) => wsSendPoint(ws, wss, dta, 'From handleLink(): '), saveDir + path.basename(url));
}

/**
 * Take a list of links and return unrestricted Links from real debrid
 * @param {Object} ws - the websocket on which to send updated endpoint data
 * @param {Object} wss - the full set of ws clients
 * @param {Object} msg - the link data list of links in the form {links: ["link", "link", "link"], linksPw: "passwd", saveDir: "/path/to/save"}
 */
function sbmtLinks(ws, wss, msg) {
	msg.links.forEach(
		async link => handleLink(
				ws,
				wss,
				await fetchWebDta(
					link,
					{
						method: "POST",
						headers: { Authorization: "Bearer " + settings.debridAccount.apiToken },
						timeout: settings.debridAccount.requestTimeout
					}
				),
				msg.saveDir
			)
	);
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
			ws.on('message', message => sbmtLinks(ws, wss, JSON.parse(message)));
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
