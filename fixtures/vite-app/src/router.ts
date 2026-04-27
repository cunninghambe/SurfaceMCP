// Pattern P3 — createBrowserRouter config form
// This router is NOT mounted in main.tsx; it exists to verify the extractor
// finds createBrowserRouter routes independent of the JSX form.
import { createBrowserRouter } from 'react-router-dom';
import { About } from './pages/About';

export const router = createBrowserRouter([
  { path: '/about', element: <About /> },
]);
