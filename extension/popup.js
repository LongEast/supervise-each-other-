const s = document.getElementById('s');
fetch('http://127.0.0.1:17321/ping')
  .then((r) => r.text())
  .then((t) => {
    if (t !== 'buddy-pet') throw new Error();
    s.textContent = '✓ 已连接到桌面小狗';
    s.className = 'ok';
  })
  .catch(() => {
    s.textContent = '✗ 没找到小狗，请先打开 Buddy Pet';
    s.className = 'bad';
  });
