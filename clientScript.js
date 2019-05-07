<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<title>xr18</title>
	<style>
		body { font-family: Arial, Helvetica, sans-serif; }
		h1 { color: maroon; }
		h2 {
			color: DarkSlateGray;
			margin: 40px 0px 0px;
		}
		div {
			width: 200px;
			padding-left: 30px;
		}
		#status {
			font-family: "Courier New", Courier, monospace;
			font-size: 20px;
		}
    #statusTable {
      font-size: 14px;
      padding-bottom: 20px;
    }
		button {
			background-color: ForestGreen;
			color: white;
			font-size: 20px;
			height: 70px;
			width: 130px;
			border-radius: 35%;
		}
    .redFont { color: DarkRed; }
    .greenFont { color: ForestGreen; }
    .blueFont { color: DarkBlue; }
	</style>
  <script>
    const skt = new WebSocket(window.location.href.replace('http://', 'ws://').replace('https://', 'wss://'));
    let msg = {}; // format: { isRecording: 'recording information', files: ['fileName1', 'fileName2'] }
    function $(sel) { return document.getElementById(sel); }
    function getStatus() { skt.send("getStatus"); }
    skt.onmessage = function(event) {
      const st = $('status');
      const bt = $('startStopBtn');
      msg = JSON.parse(event.data);
      if (msg.isRecording) {
        st.innerText = '[Recording]';
        st.className = 'redFont';
        $('statusTable').innerHTML = `<tr><td>Filename:</td><td>${msg.isRecording.fileName}</td></tr>
                                      <tr><td>Channels:</td><td>${msg.isRecording.numChannels}</td></tr>
                                      <tr><td>Time:</td><td>${msg.isRecording.recordTime}</td></tr>
                                      <tr><td>Size:</td><td>${msg.isRecording.fileSize}</td></tr>
                                      <tr id="clipCnt"><td>Clips:</td><td>${msg.isRecording.numClips}</td></tr>`;
        if (msg.isRecording.numClips > 0) $('clipCnt').className = 'redFont';
        bt.value= 'Stop';
        bt.style.backgroundColor = 'DarkRed';
      } else {
        st.innerText = '[Stopped]';
        st.className = 'blueFont';
        bt.value= 'Record';
        bt.style.backgroundColor = 'ForestGreen';
      }
      if (msg.files) {
        const tbl = $('filesTable');
        tbl.innerHTML = '';
        for (let i = 0; i < msg.files.length; i++) {
          tbl.innerHTML += `<tr><td>${msg.files[i]}</td><td class="redFont">[Delete]</td></tr>`;
        }
      }      
    }
    function startStopBtnClick() {
      if (msg.isRecording) skt.send("stopRecording");  // *** TO DO - add "are you sure"
      else skt.send("startRecording");
    }
    skt.onopen = getStatus;
    setInterval(getStatus, 7500);
  </script>
</head>
<body class="blueFont">
	<h1>xr18</h1>
	<div>
		<h3 id="status">[Stopped]</h3>
    <table id="statusTable"></table>
		<button id="startStopBtn" onclick="startStopBtnClick()">Record</button>
	</div>
	<h2>Files:</h2>
	<table id="filesTable">
	  <tr>
		  <td>File Link</td><td class="redFont">[Delete]</td>
	  </tr>
	</table>
</body>
</html>
