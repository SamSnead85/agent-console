/* Runs before first paint so a chosen theme never flashes the other one.
   "system" (no attribute) follows the operating system. */
(function () {
  try {
    var saved = localStorage.getItem("agent-console-theme");
    if (saved === "light" || saved === "dark") document.documentElement.setAttribute("data-theme", saved);
  } catch (e) { /* storage unavailable: follow the system */ }
})();
