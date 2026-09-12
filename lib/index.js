//#region src/index.ts
/**
* dsh-age, node half.
*
* Deliberately empty. Everything this plugin does is local to the page: the
* scan scheduler, the hitches, the transcript freezes and the HUD all run in
* the browser, and every knob a user can turn lives in the settings page and
* persists to that browser's `localStorage`.
*
* There is nothing honest for a host half to do. Registering a settings
* namespace here would imply the values are shared across browsers and
* surfaces, which they are not; serving an asset route would only exist to
* pass bytes to a client that already carries them inlined.
*
* The consequence worth stating plainly: a TUI, ACP, or headless surface
* simply has no AGE, because there is no page to stutter. That is the correct
* degradation, not a gap.
*/
const name = "dsh-age";
const inject = [];
/**
* Load the plugin's node half.
*
* @param _ctx - host context, unused.
*/
function apply(_ctx) {}
//#endregion
export { apply, inject, name };
