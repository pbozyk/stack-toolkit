(async () => {
  try {
    const res = await fetch('/api/config');
    const c = await res.json();
    document.querySelector('#stacks').innerHTML = `${stackCrumb('Source', c.source)}${icon('arrow-right', 'arrow')}${stackCrumb('Target', c.target)}`;
  } catch {
    // The tiles work without the stack bar.
  }
})();
