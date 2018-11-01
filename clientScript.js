function submitBtn() {
	skt.send(JSON.stringify(
		{
			links: document.getElementById('linksBox').value.split(/\n/),
			linksPw: document.getElementById('linkPwInput').value,
			saveLoc: document.getElementById('saveLocationSelect').value
		}
	));
}

const skt = new WebSocket(window.location.href.replace('http://', 'ws://').replace('https://', 'wss://'));

skt.onmessage = function(event) {
    let msg = JSON.parse(event.data);
	let statusElement = document.getElementById('statusText');
	statusElement.innerHTML = statusElement.innerHTML + '</p><p>' + msg;
};
