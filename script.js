for (const button of document.querySelectorAll("[data-copy-target]")) {
  button.addEventListener("click", async () => {
    const target = document.getElementById(button.dataset.copyTarget);
    if (!target) return;
    try {
      await navigator.clipboard.writeText(target.innerText);
      button.classList.add("is-copied");
      button.textContent = "Copied";
      setTimeout(() => {
        button.classList.remove("is-copied");
        button.textContent = "Copy";
      }, 1500);
    } catch {
      button.textContent = "Select to copy";
    }
  });
}
