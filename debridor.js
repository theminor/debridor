'use strict';
const fs = require('fs');
const http = require('http');
const https = require('https');
const WebSocket = require('ws');
const path = require('path');
const settings = require('./settings.json');
const linksStatus = {downloading: [], unrestricting: [], errors: [], completed: []};

/**
 * Utility function to iterate through an array for all elments matching the given object and remove those that match
 * @param {Array} arry - teh array on which to operate
 * @param {Object} elmnt - the element to match and remove from the array
 * @returns {boolean} returns true if a match was found and the array was altered
 */
function removeArrayElement(arry, elmnt) {
	let matchFound = false;
	for (var i = 0; i < arry.length; i++){
		if (arry[i] === elmnt) {
			arry.splice(i, 1);
			matchFound = true;
		}
	}
	return matchFound;
}

/**
 * Send a data on the given websocket
 * @param {Object} [ws] - the websocket object. If not specified, nothing is sent
 * @param {Object} dta - the data to send
 */
function wsSendData(ws, dta) {
	if (ws && ws.readyState === WebSocket.OPEN) ws.send(
		JSON.stringify(dta),
		err => err ? logMsg(err) : true
	);
}

/**
 * Log an error or other message
 * @param {Error || String} errOrMsg - an error Object that was thrown or a message to log
 * @param {Object} [reject] - if specified, reject will be thrown on behalf of the Promise in the underlying function that called logMsg
 * @param {String} [linksStatElmnt] - if specified, search linksStatus for linksStatElmnt and move it to linksStatus.errors
 * @param {Object} [ws] - the websocket object. If specified, the message will also be sent on the websocket; otherwise it will only be logged on the server
 * @param {String} [level="warn"] - the log level ("log", "info", "error", "debug", "warn", etc.)
 * @param {boolean} [supressStack=false] - by default, the complete call stack will logged; if supressStack is set true only the message will be logged
 * @returns {Error} the error as an Error object (even if a srring was supplied)
 */
function logMsg(errOrMsg, reject, linksStatElmnt, ws, level, supressStack) {
	if (typeof errOrMsg === 'string') errOrMsg = new Error(errOrMsg);
	let errDate = new Date();
	console[level || 'warn']('*** ' + errDate.toLocaleString() + ' ***  ' + errOrMsg.message + '\n');
	if (ws) wsSendData(ws, errOrMsg.message + '\n');  // for websocket, always send just the current message, and don't include the error stack, regardless of supressStack
	if (!supressStack && errOrMsg.stack && (errOrMsg.stack.trim() !== '')) console[level || 'warn'](errOrMsg.stack + '\n');  // tack on the err.stack only if supressStack is false (the default) and an err.stack actually exists and isn't empty
	if (linksStatElmnt) {
		for (const aryName of Object.keys(linksStatus)) {
			if (removeArrayElement(linksStatus[aryName], linksStatElmnt) && (aryName !== 'errors')) {         // removeArrayElement() returns true if an item was removed. If it was in the errors list, do just remove it and be done.
				linksStatus.errors.push({ "item": linksStatElmnt, "error": errOrMsg, "date": errDate });      // if it wasn't in teh errrors list, add it to the list
				if (linksStatus.errors.length > settings.server.maxErrLogLength) linksStatus.errors.shift();  // remove top item, if the list is getting too long
			}
		}
	}
	if (reject) reject(errOrMsg);
	return errOrMsg;
}

/**
 * Handle a link - unrestrict the link from real debrid
 * @param {String} url - the link to handle
 * @param {String} [linkPw] - the link password, if any
 * @param {Object} [ws] - the websocket object. If specified, error messages will also be sent on the websocket; otherwise it will only be logged on the server
 * @returns {Promise} resolves into string: url of the unrestricted link
 */
function unrestrictLink(url, linkPw, ws) {
	return new Promise((resolve, reject) => {
		linksStatus.unrestricting.push(url);
		let req = https.request(  // *** TO DO: handle plain http requests?
			settings.debridAccount.apiBaseUrl + 'unrestrict/link',  // per real debrid api - probably https://api.real-debrid.com/rest/1.0/unrestrict/link 
			{ method: "POST", headers: { Authorization: "Bearer " + settings.debridAccount.apiToken }, timeout: settings.debridAccount.requestTimeout },
			res => {
				let dta = '';
				res.on('error', err => logMsg(err, reject, url, ws));
				res.on('data', chunk => dta += chunk);
				res.on('end', () => {
					removeArrayElement(linksStatus.unrestricting, url);
					resolve(JSON.parse(dta).download); // per the api, "link" is the original link, and "download" is the unrestricted link
				});
			}
		);	
		req.on('timeout', () => logMsg(`Timeout unrestricting ${url} from real debrid, url`, reject, url, ws));
		req.end('link=' + url + (linkPw ? '&password=' + linkPw : ''));  // write and end post data like this: "link=https://link.to/file.mkv.html&password=password"
	});
}

/**
 * Download a file from a given url and save to a given location
 * @param {String} url - the url of the file to download
 * @param {String} storeLocation - full path and filename at which to store the downloaded file
 * @param {Object} [ws] - the websocket object. If specified, error messages will also be sent on the websocket; otherwise it will only be logged on the server
 * @returns {Promise} resolves to storeLocation - the location where the file was successfully saved
 */
function downloadFile(url, storeLocation, ws) {
	return new Promise((resolve, reject) => {
		let lsElement = {"url": url, "file": null, "fileSize": null, "request": null};	
		linksStatus.downloading.push(lsElement);		
		lsElement.file = fs.createWriteStream(storeLocation)
		lsElement.request = https.get(  // *** TO DO: handle plain http requests?
			url,
			{timeout: settings.debridAccount.requestTimeout}
		);
		function dlErrHandle(err) {
			if (lsElement.request) lsElement.request.abort();
			if (lsElement.file) file.close();
			fs.unlink(storeLocation);
			logMsg(err, reject, lsElement, ws);
		}
		lsElement.file.on('error', err => dlErrHandle(err));
		lsElement.request.on('error', err => dlErrHandle(err));
		lsElement.request.on('timeout', () => dlErrHandle('Timeout requesting file at ' + url));		
		lsElement.request.on('response', res => {
			if (res.headers) lsElement.fileSize = parseInt(res.headers['content-length'], 10);
			if (res.statusCode !== 200) dlErrHandle('Status code from ' + url + ' was ' + res.statusCode + ' (expecting status code 200)');
			res.on('error', err => dlErrHandle(err));
			res.pipe(lsElement.file);
		});
		lsElement.file.on('finish', () => {
			wsSendData(ws, 'download of ' + url + ' complete');
			removeArrayElement(linksStatus.downloading, lsElement);
			linksStatus.completed.push(storeLocation);
			return resolve(storeLocation);
		});		
	});
}

/**
 * Cancel a pending operation and remove it from the list
 * @param {Object} ws - the websocket to send update on when completed
 * @param {String} urlOrPath - the path or url describing the download or listed item for removal
 */
function cancelJob(ws, urlOrPath) {
	// *** TO DO - if job is downloading, it goes to completed files; if anythign else it isn't removed!
	for (var i = 0; i < linksStatus.downloading.length; i++){   // cancel pending downloads that match and close the file that is being written, if any
		if (urlOrPath === linksStatus.downloading[i].file.path) {
			if (linksStatus.downloading[i].request) linksStatus.downloading[i].request.abort();
			if (linksStatus.downloading[i].file) linksStatus.downloading[i].file.close();
		}
		logMsg('download cancelled', null, urlOrPath, ws, null, true);  // if error type was clicked, remove it and be done. Otherwise, add to error list
	}
}

/**
 * Take a list of links and return unrestricted Links from real debrid
 * @param {Object} ws - the websocket on which to send updated data
 * @param {Array} links - array of strings continaing the urls to unrestrict and then download
 * @param {Array} storeageDir - directory at which to store the downloaded files
 * @param {Object} [linksPasswd] - password for the links (if any)
 */
function submitLinks(ws, links, storeageDir, linksPasswd) {	
	fs.access(storeageDir, fs.constants.W_OK, err => {  // ensure directory is writable by this process
		if (err) return err;
		else {
			links.forEach(async lnk => {
				wsSendData(ws, 'unrestricting link: ' + lnk);
				let unRestLnk = await unrestrictLink(lnk, linksPasswd, ws);
				wsSendData(ws, 'downloading from unrestricted link: ' + unRestLnk);
				let successDir = await downloadFile(unRestLnk, storeageDir + path.basename(unRestLnk), ws);
				wsSendData(ws, 'file saved to ' + successDir);
			});
		}
	});	
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
	fs.readFile(server.filesCache[fileName].path, (err, data) => {
		if (err) return logMsg(err);
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
			logMsg('Client requested a file not in server.filesCache: "' + request.url + '" (parsed to filename: ' + fileName + ')');
			response.writeHead(404, {"Content-Type": "text/plain"});
			response.end('404 Not Found\n');	
		}
	} catch(err) { logMsg(err); }
});
server.listen(settings.server.port, err => {
	if (err) return logMsg(err);
	else {
		const wss = new WebSocket.Server({server});
		wss.on('connection', ws => {
			function closeWs(ws, err) {
				if (err && !err.message.includes('CLOSED')) logMsg(err);
				clearInterval(ws.pingTimer);
				return ws.terminate();
			}
			ws.isAlive = true;
			ws.on('message', msg => {
				msg = JSON.parse(msg);
				if (msg.remove) cancelJob(ws, msg.remove);
				else if (msg.links) submitLinks(ws, msg.links, msg.saveLoc, msg.linksPw);
				wsSendData(ws, JSON.stringify(linksStatus, (k, v) => k === 'request' ? undefined : v));  // previously only if (msg.getStatus) - but better to update links status with teh client this on every activity; stingify except don't include linksStatus.downloading[i].request because it is circular
			});
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

// *** TO DO: pull local directories to save locations on client?
