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

function statusBtn() {
	skt.send('getStatus');
}

setInterval(statusBtn, 7500);  // update status every 7.5 seconds

skt.onmessage = function(event) {
	let msg = JSON.parse(event.data);
	if (typeof msg === 'string' && msg.startsWith('{')) msg = JSON.parse(msg);  // needed for bug re "over-stringified" json
	if (typeof msg === 'object') {
		let progBarsDiv = document.getElementById('progBars');
		while (progBarsDiv.hasChildNodes()) { progBarsDiv.removeChild(progBarsDiv.lastChild); }  // remove all bars and re-build each, below
		function addBar(current, max, text, style) {
			let newBar = progBarsDiv.appendChild(document.createElement('div'));
			newBar.className = 'progress-bar ' + style;
			newBar.setAttribute('role', 'progressbar');
			newBar.setAttribute('style', 'width: ' + (current / max * 100).toString() + '%');
			newBar.setAttribute('aria-valuenow', current);
			newBar.setAttribute('aria-valuemin', 0);
			newBar.setAttribute('aria-valuemax', max);
			newBar.innerText = text || ((current / max * 100).toFixed(1).toString() + '%');
		}
		if (msg.unrestricting) msg.unrestricting.forEach(unr => addBar(100, 100, unr, 'bg-warning'));
		if (msg.downloading) msg.downloading.forEach(unr => addBar(unr.file.bytesWritten, unr.fileSize, (unr.file.path + ': ' + (unr.file.bytesWritten / unr.fileSize * 100).toFixed(1) + '% (' + unr.file.bytesWritten + ' of ' + unr.fileSize + ' bytes)')), 'bg-info');
		if (msg.completed) msg.completed.forEach(unr => addBar(100, 100, unr, 'bg-success'));
		if (msg.errors) msg.errors.forEach(unr => addBar(100, 100, unr, 'bg-danger'));
	} else console.log(msg);
}
