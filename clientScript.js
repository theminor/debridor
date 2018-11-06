function submitBtn() {
	skt.send(JSON.stringify(
		{
			links: document.getElementById('linksBox').value.split(/\n/),
			linksPw: document.getElementById('linkPwInput').value,
			saveLoc: document.getElementById('saveLocationSelect').value
		}
	));
}

function statusBtn() { skt.send('getStatus'); }

const skt = new WebSocket(window.location.href.replace('http://', 'ws://').replace('https://', 'wss://'));

skt.onmessage = function(event) {
	let msg = JSON.parse(event.data);
	let statusElement = document.getElementById('statusText');
	let progBarsDiv = document.getElementById('progBars');
	while (progBarsDiv.hasChildNodes()) { progBarsDiv.removeChild(progBarsDiv.lastChild); }  // remove all bars and re-build each, below
	function addBar(current, max, text) {
		let newBar = progBarsDiv.appendChild(document.createElement('div'));
		newBar.className = 'progress-bar';
		newBar.setAttribute('role', 'progressbar');
		newBar.setAttribute('width', (current / max * 100).toString() + '%');
		newBar.setAttribute('aria-valuenow', current / max * 100);
		newBar.setAttribute('aria-valuemin', 0);
		newBar.setAttribute('aria-valuemax', max);
		newBar.innerText = text || ((current / max * 100).toString() + '%');
	}
	if (msg.unrestricting) msg.unrestricting.forEach(unr => addBar(100, 100, unr));
	if (msg.downloading) msg.downloading.forEach(unr => addBar(unr.file.bytesWritten, unr.fileSize, (unr.file.path + ': ' + (unr.file.bytesWritten / unr.fileSize * 100) + '% (' + unr.file.bytesWritten + ' of ' + unr.fileSize + ' bytes)')));
	statusElement.innerHTML = statusElement.innerHTML + '\n' + msg;
};
