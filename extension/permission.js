// 마이크 권한을 한 번 받는 페이지. offscreen 문서는 권한 대화상자를 띄우지 못해 여기서 받는다.
const $ = (s) => document.querySelector(s);

async function showDevices() {
  const ds = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications');
  $('#devs').innerHTML = '';
  for (const d of ds) { const li = document.createElement('li'); li.textContent = d.label || '이름 없는 마이크'; $('#devs').append(li); }
}

$('#allow').addEventListener('click', async () => {
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach((t) => t.stop());
    $('#msg').textContent = '허용했습니다. 이 탭을 닫고, 녹화할 탭에서 확장 아이콘을 다시 눌러 주세요. 쓸 수 있는 마이크:';
    $('#allow').hidden = true;
    await showDevices();
  } catch (e) {
    $('#msg').textContent = `허용되지 않았습니다(${e.name}). 주소창 왼쪽 아이콘에서 마이크를 «허용»으로 바꾸거나, macOS 시스템 설정에서 이 브라우저의 마이크를 켜 주세요.`;
  }
});

navigator.permissions.query({ name: 'microphone' }).then((p) => {
  if (p.state === 'granted') { $('#msg').textContent = '이미 허용되어 있습니다. 쓸 수 있는 마이크:'; $('#allow').hidden = true; showDevices(); }
}).catch(() => {});
