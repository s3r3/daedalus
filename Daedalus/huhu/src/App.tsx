import { useState, useEffect } from 'react'
import './App.css'

function App() {
  const [scrollY, setScrollY] = useState(0)

  useEffect(() => {
    const handleScroll = () => setScrollY(window.scrollY)
    window.addEventListener('scroll', handleScroll)
    return () => window.removeEventListener('scroll', handleScroll)
  }, [])

  return (
    <>
      <section className="hero">
        <div className="hero-content" style={{ transform: `translateY(${scrollY * 0.5}px)` }}>
          <h1 className="title">Aceh</h1>
          <p className="subtitle">Serambi Mekkah</p>
          <div className="ornament"></div>
        </div>
        <div className="wave"></div>
      </section>

      <section className="about">
        <div className="container">
          <div className="card fade-in">
            <h2>Tanah Rencong</h2>
            <p>
              Aceh adalah provinsi paling barat Indonesia yang terletak di ujung pulau Sumatera. 
              Dikenal dengan julukan Serambi Mekkah karena kehidupan masyarakatnya yang sangat 
              kental dengan nilai-nilai Islam.
            </p>
          </div>

          <div className="grid">
            <div className="card slide-left">
              <div className="icon">🕌</div>
              <h3>Masjid Raya Baiturrahman</h3>
              <p>Simbol kejayaan Islam di Aceh dengan arsitektur megah dan sejarah panjang.</p>
            </div>

            <div className="card slide-right">
              <div className="icon">🌊</div>
              <h3>Tsunami 2004</h3>
              <p>Aceh bangkit dari tragedi tsunami dengan kekuatan dan semangat yang luar biasa.</p>
            </div>

            <div className="card slide-left">
              <div className="icon">☕</div>
              <h3>Kopi Gayo</h3>
              <p>Kopi berkualitas tinggi yang terkenal hingga mancanegara dari dataran tinggi Gayo.</p>
            </div>

            <div className="card slide-right">
              <div className="icon">⚔️</div>
              <h3>Senjata Rencong</h3>
              <p>Senjata tradisional khas Aceh yang melambangkan keberanian dan kehormatan.</p>
            </div>
          </div>
        </div>
      </section>

      <section className="culture">
        <div className="container">
          <h2 className="section-title">Budaya & Tradisi</h2>
          <div className="culture-grid">
            <div className="culture-item">
              <div className="pulse-circle"></div>
              <h3>Tari Saman</h3>
              <p>Tarian tradisional yang diakui UNESCO sebagai warisan budaya takbenda</p>
            </div>
            <div className="culture-item">
              <div className="pulse-circle"></div>
              <h3>Seni Ukir</h3>
              <p>Keahlian mengukir kayu dengan motif khas Aceh yang indah dan rumit</p>
            </div>
            <div className="culture-item">
              <div className="pulse-circle"></div>
              <h3>Kuliner</h3>
              <p>Mie Aceh, Kuah Pliek U, dan beragam kuliner lezat khas Aceh</p>
            </div>
          </div>
        </div>
      </section>

      <footer className="footer">
        <div className="container">
          <p>Aceh - Tanah yang penuh sejarah, budaya, dan keindahan alam</p>
          <div className="footer-ornament"></div>
        </div>
      </footer>
    </>
  )
}

export default App
