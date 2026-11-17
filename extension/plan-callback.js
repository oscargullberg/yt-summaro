const query = location.hash.slice(1);
history.replaceState(null, "", location.pathname);
try {
  const reply = await chrome.runtime.sendMessage({ type: "plan-callback", query });
  if (!reply?.accepted) throw new Error();
} catch {
  document.querySelector("p").textContent = "This sign-in attempt has ended. Return to YT Summaro Settings to try again.";
}
