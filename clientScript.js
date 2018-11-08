const skt = new WebSocket(window.location.href.replace('http://', 'ws://').replace('https://', 'wss://'));

function submitBtn() {
	skt.send(JSON.stringify(
		{
			links: document.getElementById('linksBox').value.trim().split(/\n/),
			linksPw: document.getElementById('linkPwInput').value,
			saveLoc: document.getElementById('saveLocationSelect').value
		}
	));
}

function getStatus() {
	skt.send(JSON.stringify({ getStatus: true} ));
}

skt.onmessage = function(event) {
	let msg = JSON.parse(event.data);
	if (typeof msg === 'string' && msg.startsWith('{')) msg = JSON.parse(msg);  // needed for bug re "over-stringified" json
	if (typeof msg === 'object') {
		let progBarsDiv = document.getElementById('progBars');
		while (progBarsDiv.hasChildNodes()) { progBarsDiv.removeChild(progBarsDiv.lastChild); }  // remove all bars and re-build each, below
		function addBar(current, max, path, style) {
			let newBar = progBarsDiv.appendChild(document.createElement('div'));
			newBar.className = 'progress-bar ' + style;
			newBar.setAttribute('role', 'progressbar');
			newBar.setAttribute('style', 'width: ' + (current / max * 100).toString() + '%');
			newBar.setAttribute('aria-valuenow', current);
			newBar.setAttribute('aria-valuemin', 0);
			newBar.setAttribute('aria-valuemax', max);
			newBar.onclick((mouseEvent) => skt.send(JSON.stringify({ remove: path })));
			if (current === 100 && max === 100) newBar.innerText = path;
			else newBar.innerText = path + ': ' + Math.round(current/max * 100) + '% (' + Math.round(current/1000000) + ' of ' + Math.round(max/1000000) + ' MB)';
		}
		if (msg.unrestricting) msg.unrestricting.forEach(unr => addBar(100, 100, unr, 'bg-warning'));
		if (msg.downloading) msg.downloading.forEach(unr => addBar(unr.file.bytesWritten, unr.fileSize, unr.file.path, 'bg-info'));
		if (msg.completed) msg.completed.forEach(unr => addBar(100, 100, unr, 'bg-success'));
		if (msg.errors) msg.errors.forEach(unr => addBar(100, 100, unr, 'bg-danger'));
	} else console.log(msg);
}

setInterval(getStatus, 7500);  // update status every 7.5 seconds
getStatus(); // and update on page load

