const frame = document.getElementById('geostate-comparison');
window.addEventListener('message', event => {
  if (event.source !== frame?.contentWindow || event.data?.type !== 'geostate-comparison-height') return;
  const height = Number(event.data.height);
  if (Number.isFinite(height) && height > 200 && height < 3000) frame.style.height = `${Math.ceil(height)}px`;
});
