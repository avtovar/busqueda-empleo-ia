// ============================================================================
// PrivacyNotice.jsx — Aviso de privacidad y consentimiento (Ley 25.326)
// ============================================================================

import { useState } from 'react';

export default function PrivacyNotice({ onAccept, onDecline, show = true, providerName = 'el proveedor configurado (OpenAI-compatible)' }) {
  const [scrolled, setScrolled] = useState(false);

  if (!show) return null;

  const handleScroll = (e) => {
    // Detectar si el usuario llegó al final del texto
    const { scrollTop, scrollHeight, clientHeight } = e.target;
    if (scrollTop + clientHeight >= scrollHeight - 10) {
      setScrolled(true);
    }
  };

  return (
    <div className="privacy-modal" role="dialog" aria-modal="true" aria-labelledby="privacy-title">
      <div className="privacy-content">
        <header className="privacy-header">
          <h2 id="privacy-title">Aviso de privacidad y consentimiento</h2>
          <p className="privacy-subtitle">Ley 25.326 — Protección de Datos Personales (Argentina)</p>
        </header>

        <div className="privacy-body" onScroll={handleScroll}>
          <section>
            <h3>1. ¿Qué datos recolectamos?</h3>
            <p>Al subir tu CV (PDF o DOCX), extraemos el texto y lo enviamos a un <strong>modelo de lenguaje (LLM)</strong> para armar tu perfil profesional: nombre, título, años de experiencia, resumen, skills con pesos y keywords de búsqueda.</p>
            <p><strong>El archivo del CV NUNCA se guarda en nuestros servidores ni en base de datos.</strong> Solo se procesa en memoria durante la extracción y se descarta inmediatamente.</p>
          </section>

          <section>
            <h3>2. ¿A dónde viajan tus datos?</h3>
            <p>El texto de tu CV se envía a <strong>{providerName}</strong> a través de una API compatible con OpenAI. Esta transferencia puede implicar que los datos salgan de Argentina (según dónde esté alojado el proveedor).</p>
            <p>El proveedor del LLM es <strong>configurable por el dueño de la app</strong> vía variable de entorno <code>LLM_BASE_URL</code> (por defecto <code>https://api.openai.com/v1</code>).</p>
          </section>

          <section>
            <h3>3. ¿Qué se guarda de tu perfil?</h3>
            <ul>
              <li>Nombre completo</li>
              <li>Título profesional</li>
              <li>Años de experiencia</li>
              <li>Resumen / &ldquo;Sobre m&iacute;&rdquo;</li>
              <li>Ubicación (ciudad, provincia)</li>
              <li>Skills con peso (0 a 1)</li>
              <li>Keywords de búsqueda</li>
              <li>Links (LinkedIn, GitHub, portfolio)</li>
              <li>Proyectos (nombre, descripción, URL, lenguaje)</li>
            </ul>
            <p>Estos datos se guardan en <strong>Postgres (Neon o Supabase)</strong> asociados a tu usuario, y solo vos podés verlos, editarlos o borrarlos.</p>
          </section>

          <section>
            <h3>4. ¿Para qué usamos tus datos?</h3>
            <ul>
              <li>Calcular el <strong>match</strong> entre tu perfil y ofertas de empleo reales.</li>
              <li>Generar <strong>cartas de presentación</strong> personalizadas.</li>
              <li>Armar la <strong>Propuesta de Interés</strong> (demanda del mercado vs tu perfil).</li>
              <li>Prellenar búsquedas en el <strong>Directorio de empleo</strong> de Argentina.</li>
            </ul>
          </section>

          <section>
            <h3>5. Tus derechos (Ley 25.326)</h3>
            <ul>
              <li><strong>Acceso:</strong> Podés ver todos tus datos en cualquier momento.</li>
              <li><strong>Rectificación:</strong> Editá tu perfil cuando quieras desde el panel.</li>
              <li><strong>Supresión:</strong> Borrá tu cuenta y <strong>TODOS</strong> tus datos con un click (secci&oacute;n &ldquo;Zona de peligro&rdquo;).</li>
              <li><strong>Portabilidad:</strong> Exportá tu perfil en JSON (próximamente).</li>
            </ul>
          </section>

          <section>
            <h3>6. Retención</h3>
            <p>Tu perfil se guarda mientras tu cuenta exista. Al borrar la cuenta, <strong>se elimina todo en cascada</strong> (perfil, skills, búsquedas, historial, favoritos, logs de parseo, logs de Apify) y queda solo una fila de auditoría en <code>account_deletions</code> con tu email, fecha, IP y User-Agent (para cumplimiento legal).</p>
            <p>Los logs de parseo de CV (<code>cv_parses</code>) se purgan a las 24 horas. Los logs de Apify (<code>apify_usage</code>) a los 60 días.</p>
          </section>

          <section>
            <h3>7. Autoridad de control</h3>
            <p>Agencia de Acceso a la Información Pública (AAIP) — <a href="https://www.aaip.gob.ar" target="_blank" rel="noopener noreferrer">aaip.gob.ar</a></p>
          </section>
        </div>

        <footer className="privacy-footer">
          <label className="privacy-consent">
            <input
              type="checkbox"
              disabled={!scrolled}
              onChange={(e) => {
                if (e.target.checked) onAccept();
                else onDecline();
              }}
              aria-describedby="privacy-consent-desc"
            />
            <span id="privacy-consent-desc">
              He leído y entiendo el aviso de privacidad. <strong>Consiento</strong> que el texto de mi CV sea enviado a {providerName} para armar mi perfil.
            </span>
          </label>
          <p className="privacy-hint">{scrolled ? '' : '↓ Desplazá hasta el final para habilitar el consentimiento'}</p>
        </footer>
      </div>
    </div>
  );
}