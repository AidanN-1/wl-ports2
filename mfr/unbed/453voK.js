const ad = "https://recollectsideway.com/i7dd7ruzr?key=e370275100340ce26eafdcb83fe93826";

if (window.self !== window.top) {
  document.addEventListener("click", () => {
    try {
      if (sessionStorage.getItem("clicked") === "1") {
        return;
      }

      const domains = [
        "caesium.pages.dev",
        "unpkg.com",
        "esm.sh",
        "cdn.jsdelivr.net",
        "getfavicon.dev"
      ];

      const host = window.parent.location.hostname;

      const allowed = domains.some(domain =>
        host === domain || host.endsWith("." + domain)
      );

      if (allowed) {
        alert("if the game gets stuck loading, refresh the page ");
        const profit = window.open(ad, "_blank");

        if (profit) {
          sessionStorage.setItem("clicked", "1");
        }
      }
    } catch (e) {
      console.warn("error! ", e);
    }
  }, { once: true });
}
