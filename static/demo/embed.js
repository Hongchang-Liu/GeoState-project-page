// Resize only the isolated interactive component, preserving the page template.
const iframe = document.getElementById('geostate-live-demo');
window.addEventListener('message', event => {
  if (event.origin !== location.origin || event.source !== iframe?.contentWindow || event.data?.type !== 'geostate-demo-height') return;
  const height = Number(event.data.height);
  if (Number.isFinite(height) && height >= 300 && height <= 3000) iframe.style.height = `${height}px`;
});
