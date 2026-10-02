import React from 'react';
// ↑ Importamos React aunque no lo usemos directamente: es el "abuelo" que todas
//   las piezas necesitan bajo el nuevo transform de JSX (buena práctica dejarlo).

import ReactDOM from 'react-dom/client';
// ↑ ReactDOM es el puente entre React y el DOM del navegador. Desde su versión 18,
//   se usa createRoot() que monta la app y maneja las actualizaciones de forma moderna.

import App from './App.jsx';
// ↑ Importamos el componente raíz de toda la app. `App` es el "cerebro" que luego
//   se encarga de orquestar al resto de los componentes.

import './styles.css';
// ↑ Estilos globales de la app (tema oscuro, cards, modales, etc.). Se importan
//   una sola vez acá para que Vite los inyecte y apliquen a toda la página.

// Buscamos el <div id="root"> que está en index.html y montamos la app ahí adentro.
ReactDOM.createRoot(document.getElementById('root')).render(
  // ↑ createRoot() recibe el elemento del DOM donde va a vivir React.
  //   El render() es quien "pinta" todo el árbol de componentes dentro de #root.

  <React.StrictMode>
    {/* ↑ StrictMode es un modo de desarrollo que ayuda a encontrar errores:
        ejecuta dos veces los componentes y detecta efectos con problemas. No
        cambia nada visible en pantalla, solo "controla" el código por nosotros. */}
    <App />
    {/* ↑ Acá se renderiza el componente principal: casi todo el trabajo real
        está dentro de App.jsx y de sus componentes hijos. */}
  </React.StrictMode>
);