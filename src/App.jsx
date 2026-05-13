import { Search, Loader2, AlertCircle, Rss } from 'lucide-react';
import { useState } from 'react';
import { findRssFeeds } from './utils/rssFinder';
import ResultCard from './components/ResultCard';

function App() {
  const [url, setUrl] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [results, setResults] = useState(null);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);

  const showToast = (message) => {
    setToast(message);
    setTimeout(() => setToast(null), 3000);
  };

  const handleSearch = async (e) => {
    e.preventDefault();
    if (!url.trim()) return;

    let targetUrl = url.trim();
    if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
      targetUrl = 'https://' + targetUrl;
      setUrl(targetUrl); // Actualizar el input
    }

    setIsSearching(true);
    setError(null);
    setResults(null);

    try {
      const feeds = await findRssFeeds(targetUrl);
      setResults(feeds);
    } catch (err) {
      console.error(err);
      setError('No se pudo analizar la URL. Verifica que sea correcta y esté accesible.');
    } finally {
      setIsSearching(false);
    }
  };

  return (
    <div className="app-container">
      <header className="hero-section">
        <h1 className="hero-title">
          Encuentra <span>Feeds RSS</span> al Instante
        </h1>
        <p className="hero-subtitle">
          Descubre los canales RSS, Atom o JSON de cualquier sitio web. Simplemente pega la URL y deja que la herramienta haga la magia.
        </p>
      </header>

      <div className="search-container">
        <form onSubmit={handleSearch} className="search-form">
          <input
            type="text"
            className="search-input"
            placeholder="Ejemplo: https://innovacion.ec"
            aria-label="URL del sitio web"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            disabled={isSearching}
          />
          <button 
            type="submit" 
            className="search-button"
            aria-label="Buscar feeds RSS"
            disabled={isSearching || !url.trim()}
          >
            {isSearching ? (
              <Loader2 size={18} className="spinner" style={{ width: 18, height: 18, border: 'none' }} />
            ) : (
              <Search size={18} />
            )}
            Buscar
          </button>
        </form>
      </div>

      {error && (
        <div className="error-message">
          <AlertCircle size={20} />
          <p>{error}</p>
        </div>
      )}

      {isSearching && (
        <div className="loader-container">
          <div className="spinner"></div>
          <p className="loader-text">Analizando el código fuente...</p>
        </div>
      )}

      {results && !isSearching && (
        <div className="results-container">
          <div className="results-header">
            <h2 className="results-title">Resultados encontrados</h2>
            <span className="results-count">{results.length} feeds</span>
          </div>

          {results.length > 0 ? (
            results.map((feed, idx) => (
              <ResultCard key={idx} feed={feed} showToast={showToast} index={idx} />
            ))
          ) : (
            <div className="empty-state">
              <Rss size={48} opacity={0.2} style={{ marginBottom: '1rem' }} />
              <h3>No se encontraron feeds</h3>
              <p>El sitio web no parece tener etiquetas RSS públicas configuradas.</p>
            </div>
          )}
        </div>
      )}

      <div className="projects-section">
        <h3 className="projects-title">Otros proyectos de Innovación IA</h3>
        <div className="projects-grid">
          <a href="https://agentes.innovacion.ec" target="_blank" rel="noopener noreferrer" className="project-link">
            <strong>InnovAgentes</strong>
            <span>Agentes de IA para ventas</span>
          </a>
          <a href="https://innovanews.innovacion.ec" target="_blank" rel="noopener noreferrer" className="project-link">
            <strong>InnovaNews</strong>
            <span>Lector de noticias con IA</span>
          </a>
          <a href="https://innovacion.ec/proyectos" target="_blank" rel="noopener noreferrer" className="project-link">
            <strong>InnovaVoz</strong>
            <span>Dictado en macOS</span>
          </a>
        </div>
      </div>

      <footer className="app-footer">
        <p>Desarrollado por <a href="https://innovacion.ec" target="_blank" rel="noopener noreferrer">Innovación IA</a>, todos los derechos reservados.</p>
      </footer>

      {toast && (
        <div className="toast-container">
          <div className="toast">
            <svg className="toast-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12"></polyline>
            </svg>
            <span>{toast}</span>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
