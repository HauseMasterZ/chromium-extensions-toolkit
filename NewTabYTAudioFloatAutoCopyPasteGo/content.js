document.addEventListener('mouseup', e => {
  if (!e.altKey && window.getSelection().toString().trim()) document.execCommand('copy');
});