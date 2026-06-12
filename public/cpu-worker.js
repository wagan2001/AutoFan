let active = false;
let intensity = 1;

function burn() {
  if (!active) return;

  const end = performance.now() + 80 * intensity;
  let value = 0.000001;
  while (performance.now() < end) {
    value = Math.sin(value + Math.sqrt(value + 13.37)) * Math.cos(value + 0.73);
  }

  postMessage({ type: "tick", value });
  setTimeout(burn, Math.max(0, 80 * (1 - intensity)));
}

onmessage = (event) => {
  if (event.data.type === "start") {
    intensity = Math.min(1, Math.max(0.05, event.data.intensity ?? 1));
    if (!active) {
      active = true;
      burn();
    }
  }

  if (event.data.type === "stop") {
    active = false;
  }
};
