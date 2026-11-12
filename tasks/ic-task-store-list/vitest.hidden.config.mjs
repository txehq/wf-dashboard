// Vitest config for grading: the dashboard places it outside the checkout, so the checkout's vite / vitest config and setupFiles are not loaded;
// the command runs in the checkout and root is the cwd, so JUnit classnames are paths relative to the checkout root
export default {
  root: process.cwd(),
  test: {
    include: ['test/hidden/**/*.hidden.test.{js,ts}'],
  },
};
