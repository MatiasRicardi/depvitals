// A real import inside a `.cts` file must contribute to dependency analysis: `legacy-helper` is
// declared and used here (so it stays unused-free), proving the `.cts` file was actually analyzed.
import { legacy } from 'legacy-helper';

export default legacy;
