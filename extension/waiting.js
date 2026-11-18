const show = (r) => { if (r?.message) document.getElementById("msg").textContent = r.message; };
chrome.storage.local.get("ap_run").then((s) => show(s.ap_run));
chrome.storage.onChanged.addListener((c) => { if (c.ap_run) show(c.ap_run.newValue); });
