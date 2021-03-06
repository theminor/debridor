'use strict';
const fs = require('fs');
const http = require('http');
const https = require('https');
const WebSocket = require('ws');
const path = require('path');
const settings = require('./settings.json');
let postProcJs = null;
if (settings.postProcess.js) postProcJs = require(settings.postProcess.js);
const linksStatus = {downloading: [], unrestricting: [], errors: [], completed: []};

/**
 * Utility function to iterate through an array for all elments matching the given object and remove those that match
 * @param {String} arryName - the name of the array to operate on ("downloading", "unrestricting", etc.)
 * @param {Object || String} elmnt - the element to match and remove from the array (or the name of the element, in whch case the name/property will be searched for)
 * @param {boolean} [deleteFiles=false] - if true, close and delete files from linksStatus.downloading
 * @returns {boolean} returns true if a match was found and the array was altered
 */
function removeArrayElement(arryName, elmnt, deleteFiles) {
	let matchFound = false;
	let arry = linksStatus[arryName];
	if (arryName === 'errors' && typeof elmnt === 'string') {  // cover the situation where elmnt is presented as a string, but under errors, that probably refers to linksStatus.errors[i].item
		for (let i = 0; i < linksStatus.errors.length; i++){
			if (linksStatus.errors[i].item === elmnt) elmnt = linksStatus.errors[i];
		}		
	}
	if (deleteFiles && arryName === 'downloading') {
		if (typeof elmnt === 'string') {  // cover the situation where elmnt is presented as a string, but under downloading, that could refer to linksStatus.downloading[i].url or linksStatus.downloading[i].file.path
			for (let i = 0; i < linksStatus.downloading.length; i++){
				if ((linksStatus.downloading[i].url === elmnt) || (linksStatus.downloading[i].file.path === elmnt)) elmnt = linksStatus.downloading[i];
			}
		}
		if (elmnt.request && elmnt.request.abort) {
			elmnt.request.abort();  // abort any request pending, if applicable
			elmnt.aborted = true;   // needed in downloadFile()...on('finish')
		}
		if (elmnt.file) {
			if (elmnt.file.close) elmnt.file.close();  // close open files, if applicable
			fs.unlink(elmnt.file.path, (error) => { /* anything to do? */ });  // delete file being saved, if applicable
			elmnt.aborted = true;  // needed in downloadFile()...on('finish')
		}
	}
	for (let i = 0; i < arry.length; i++){  // iterate and search for a match; if found, remove it
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
 * Send update of the linksStatus object on the given websocket
 * @param {Object} [ws] - the websocket object. If not specified, nothing is sent
 */
function wsSendUpdate(ws) {
	wsSendData(ws, JSON.stringify(linksStatus, (k, v) => k === 'request' ? undefined : v));  // exclude all linksStatus.downloading[x].request objects because it is circular
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
		let matchFound = false;  // only remove from one!
		for (const aryName of Object.keys(linksStatus)) {
			if (!matchFound && (removeArrayElement(aryName, linksStatElmnt, true))) {
				matchFound = true;
				if (aryName !== 'errors') {
					linksStatus.errors.push({ "item": linksStatElmnt, "error": errOrMsg.message, "date": errDate });  // if it wasn't in the errrors list, add it to the list
					if (linksStatus.errors.length > settings.server.maxErrLogLength) linksStatus.errors.shift();  // remove top item, if the list is getting too long
				}
			}
		}
	}
	if (reject) reject(errOrMsg);
	if (ws) wsSendUpdate(ws);
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
					removeArrayElement('unrestricting', url, false);
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
 * @param {String} [passwd] - password submitted by user to pass on to post-processor (for example, to use for passworded archives)
 * @returns {Promise} resolves to storeLocation - the location where the file was successfully saved
 */
function downloadFile(url, storeLocation, ws, passwd) {
	return new Promise((resolve, reject) => {
		let lsElement = {"url": url, "file": null, "fileSize": null, "request": null, "aborted": null};	
		linksStatus.downloading.push(lsElement);		
		lsElement.file = fs.createWriteStream(storeLocation)
		lsElement.request = https.get(  // *** TO DO: handle plain http requests?
			url,
			{timeout: settings.debridAccount.requestTimeout}
		);
		lsElement.file.on('error', err => logMsg(err, reject, lsElement, ws));
		lsElement.request.on('error', err => logMsg(err, reject, lsElement, ws));
		lsElement.request.on('timeout', () => logMsg('Timeout requesting file at ' + url, reject, lsElement, ws));
		lsElement.request.on('response', res => {
			if (res.headers) lsElement.fileSize = parseInt(res.headers['content-length'], 10);
			if (res.statusCode !== 200) logMsg('Status code from ' + url + ' was ' + res.statusCode + ' (expecting status code 200)', reject, lsElement, ws);
			res.on('error', err => logMsg(err, reject, lsElement, ws));
			res.pipe(lsElement.file);
		});
		lsElement.file.on('finish', async () => {
			if (!lsElement.aborted) {  // downloads that are aborted via request.abort() (see removeArrayElement()) seem to still call file.on('finish')
				wsSendData(ws, 'download of ' + url + ' complete');
				removeArrayElement('downloading', lsElement, false);
				if (settings.postProcess && postProcJs) {  // post processing will first call the node file in settings.postProcess, (module.exports is a single function called with (linksStatus, lsElement); then it will execute a shell command via the settings.postProcess.execute object
					storeLocation = await postProcJs(linksStatus, lsElement, passwd).catch(err => console.log('post processing error: ' + err));
					console.log('post processing completed: ' + storeLocation);
				}
				linksStatus.completed.push(storeLocation);
			}
			resolve(storeLocation);
		});	
		wsSendUpdate(ws);
	});
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
				wsSendUpdate(ws);
				wsSendData(ws, 'downloading from unrestricted link: ' + unRestLnk);
				let successDir = await downloadFile(unRestLnk, storeageDir + path.basename(unRestLnk), ws, linksPasswd);
				wsSendUpdate(ws);
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
				if (msg.remove) logMsg('download cancelled', null, msg.remove, ws, null, true);
				else if (msg.links) submitLinks(ws, msg.links, msg.saveLoc, msg.linksPw);
				wsSendUpdate(ws);  // previously only if (msg.getStatus) - but better to update links status with the client this on every activity
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
