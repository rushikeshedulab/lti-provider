import { NavLink, Route, Routes, useLocation } from 'react-router-dom';
import Home from './pages/Home';
import Player from './pages/Player';
import DeepLink from './pages/DeepLink';
import Admin from './pages/Admin';

export default function App() {
  const { pathname } = useLocation();
  // The player and the deep-linking picker render inside the consumer's iframe,
  // so they must not show the provider's own chrome.
  const embedded = pathname.startsWith('/player') || pathname.startsWith('/deep-link');

  return (
    <>
      {!embedded && (
        <header className="app-header">
          <span className="brand">EduLab Content Provider</span>
          <span className="role">LTI 1.3 Tool</span>
          <nav>
            <NavLink to="/" end className={({ isActive }) => (isActive ? 'active' : '')}>
              Overview
            </NavLink>
            <NavLink to="/admin" className={({ isActive }) => (isActive ? 'active' : '')}>
              Activity Logs
            </NavLink>
          </nav>
        </header>
      )}
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/player" element={<Player />} />
        <Route path="/deep-link" element={<DeepLink />} />
        <Route path="/admin" element={<Admin />} />
        <Route
          path="*"
          element={
            <div className="page narrow">
              <div className="card">
                <h1>Not found</h1>
                <p className="muted">No such page on the content provider.</p>
              </div>
            </div>
          }
        />
      </Routes>
    </>
  );
}
