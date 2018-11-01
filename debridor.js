'use strict';
const fs = require('fs');
const http = require('http');
const https = require('https');
const WebSocket = require('ws');
const path = require('path');
const settings = require('./settings.json');


/**
 * Log an Error Message; Optionally simplify the output
 * @param {Error | String} err - an error Object that was thrown
 * @returns {Error} the error as an Error object (even if a srring was supplied)
 */
function logErr(err) {
	if (typeof err === 'string') err = new Error(err);
	console.warn('\n*** ' + new Date().toLocaleString() + ' ***  ' + err.message + ' --> ' + err.stack);
	return err;
}

/**
 * Send a data on the given websocket
 * @param {Object} [ws] - the websocket object. If not specified, nothing is sent
 * @param {Object} dta - the data to send
 */
function wsSendData(ws, dta) {
	if (ws && ws.readyState === WebSocket.OPEN) ws.send(
		JSON.stringify(dta),
		err => err ? logErr(err) : true
	);
}

/**
 * Handle a link - unrestrict the link from real debrid
 * @param {String} url - the link to handle
 * @param {String} [linkPw] - the link password, if any
 * @returns {Promise} resolves into string: url of the unrestricted link
 */
function unrestrictLink(url, linkPw) {
	return new Promise((resolve, reject) => {
		let req = https.request(  // *** TO DO: handle http requests
			settings.debridAccount.apiBaseUrl + 'unrestrict/link',  // probably https://api.real-debrid.com/rest/1.0/unrestrict/link 
			{ method: "POST", headers: { Authorization: "Bearer " + settings.debridAccount.apiToken }, timeout: settings.debridAccount.requestTimeout },
			res => {
				let dta = '';
				res.on('error', err => reject(logErr(err)));
				res.on('data', chunk => dta += chunk);
				res.on('end', () => resolve(JSON.parse(dta).download));  // per the api, "link" is the origional linke, and "download" is the unrestrivted link 
			}
		);	
		req.on('timeout', () => reject(logErr('Timeout getting unrestricted link from real debrid, url: ' + url)));
		req.end('link=' + url + (linkPw ? '&password=' + linkPw : ''));
	});
}

/**
 * Download a file from a given url and save to a given location
 * @param {String} url - the url of the file to download
 * @param {String} storeLocation - full path and filename at which to store the downloaded file
 * @returns {Promise} resolves to storeLocation - the location where the file was successfully saved
 */
function downloadFile(url, storeLocation) {
	return new Promise((resolve, reject) => {
		let file = fs.createWriteStream(storeLocation);
		function dlErrHandle(req, err) {
			req.abort();
			file.close();
			fs.unlink(storeLocation);
			reject(logErr(err))
		}
		let req = https.get(  // *** TO DO: handle http requests
			url,
			{timeout: settings.debridAccount.requestTimeout},
			res => {
				if (res.statusCode !== 200) dlErrHandle(req, 'Status code for file at ' + url + ' was ' + res.statusCode + ' (expecting status code 200)');
				let dta = '';
				res.on('error', err => dlErrHandle(req, err));
				file.on('finish', () => resolve(storeLocation));
				res.pipe(file);
			}
		);
		req.on('error', err => dlErrHandle(req, err));
		req.on('timeout', () => dlErrHandle(req, 'Timeout requesting file at ' + url));		
		file.on('error', err => dlErrHandle(req, err));
	});
}

/**
 * Take a list of links and return unrestricted Links from real debrid
 * @param {Object} ws - the websocket on which to send updated endpoint data
 * @param {Array} links - array of strings continaing the urls to unrestrict and then download
 * @param {Array} storeageDir - directory at which to store the downloaded files
 * @param {Object} [linksPasswd] - password for the links (if any)
 */
function submitLinks(ws, links, storeageDir, linksPasswd) {	
	fs.access(storeageDir, fs.constants.W_OK, err => {
		if (err) return err;
		else {  // ensure directory is writable by this process
			links.forEach(async lnk => {
				wsSendData(ws, 'unrestricting link: ' + lnk);
				let unRestLnk = await unrestrictLink(lnk, linksPasswd);
				wsSendData(ws, 'downloading from unrestricted link: ' + unRestLnk);
				let successDir = await downloadFile(unRestLnk, storeageDir + path.basename(lnk));
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
		if (err) { return logErr(err); throw(err); }
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
	} catch(err) { logErr(err); }
});
server.listen(settings.server.port, err => {
	if (err) { return logErr(err); }
	else {
		const wss = new WebSocket.Server({server});
		wss.on('connection', ws => {
			function closeWs(ws, err) {
				if (err) logErr(err);
				clearInterval(ws.pingTimer);
				return ws.terminate();
			}
			ws.isAlive = true;
			ws.on('message', msg => submitLinks(ws, JSON.parse(msg).links, JSON.parse(msg).saveLoc, JSON.parse(msg).linksPw));
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
