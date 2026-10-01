// Portal front-end. Served from /assets/ on the same origin (the CSP blocks inline scripts).
const statusEl = document.getElementById("status");

fetch("/api/health")
  .then((res) => res.json())
  .then((data) => {
    statusEl.textContent = data.ok ? "Database connected." : "Database is not ready. Run the migrations.";
    statusEl.classList.add(data.ok ? "ok" : "bad");
  })
  .catch(() => {
    statusEl.textContent = "Could not reach the server.";
    statusEl.classList.add("bad");
  });
