import './App.css'

function App() {
  return (
    <div className="container">
      <header>
        <h1>Vladimir Vladimirovich Putin</h1>
        <p className="subtitle">Президент Российской Федерации</p>
      </header>

      <section className="biodata">
        <div className="section">
          <h2>Data Pribadi</h2>
          <table>
            <tbody>
              <tr>
                <td><strong>Nama Lengkap</strong></td>
                <td>Vladimir Vladimirovich Putin (Владимир Владимирович Путин)</td>
              </tr>
              <tr>
                <td><strong>Tempat, Tanggal Lahir</strong></td>
                <td>Leningrad, RSFSR, Uni Soviet (sekarang Saint Petersburg, Rusia), 7 Oktober 1952</td>
              </tr>
              <tr>
                <td><strong>Usia</strong></td>
                <td>72 tahun (per 2024)</td>
              </tr>
              <tr>
                <td><strong>Kewarganegaraan</strong></td>
                <td>Rusia</td>
              </tr>
              <tr>
                <td><strong>Agama</strong></td>
                <td>Kristen Ortodoks Rusia</td>
              </tr>
              <tr>
                <td><strong>Status Pernikahan</strong></td>
                <td>Bercerai (dari Lyudmila Shkrebneva, menikah 1983-2014)</td>
              </tr>
              <tr>
                <td><strong>Anak</strong></td>
                <td>Maria Putina, Katerina Tikhonova (2 putri)</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div className="section">
          <h2>Pendidikan</h2>
          <ul>
            <li><strong>1975:</strong> Sarjana Hukum dari Universitas Negeri Leningrad (sekarang Universitas Negeri Saint Petersburg)</li>
            <li><strong>1997:</strong> Ph.D. dalam Ekonomi dari Saint Petersburg Mining Institute (disertasi tentang perencanaan strategis sumber daya mineral)</li>
          </ul>
        </div>

        <div className="section">
          <h2>Karir Awal</h2>
          <ul>
            <li><strong>1975-1990:</strong> Petugas intelijen KGB, bertugas di Jerman Timur (Dresden, 1985-1990)</li>
            <li><strong>1990-1996:</strong> Berbagai posisi di pemerintahan Saint Petersburg, termasuk Kepala Komite Hubungan Luar Negeri</li>
            <li><strong>1996-1999:</strong> Pindah ke Moskow, menjabat di Administrasi Presiden, FSB (Direktur, 1998-1999)</li>
          </ul>
        </div>

        <div className="section">
          <h2>Jabatan Politik</h2>
          <table>
            <tbody>
              <tr>
                <td><strong>Perdana Menteri Rusia</strong></td>
                <td>9 Agustus 1999 - 7 Mei 2000 (pertama)<br/>8 Mei 2008 - 7 Mei 2012 (kedua)</td>
              </tr>
              <tr>
                <td><strong>Presiden Rusia</strong></td>
                <td>
                  • Penjabat: 31 Desember 1999 - 7 Mei 2000<br/>
                  • Periode 1: 7 Mei 2000 - 7 Mei 2004<br/>
                  • Periode 2: 7 Mei 2004 - 7 Mei 2008<br/>
                  • Periode 3: 7 Mei 2012 - 7 Mei 2018<br/>
                  • Periode 4: 7 Mei 2018 - 7 Mei 2024<br/>
                  • Periode 5: 7 Mei 2024 - sekarang
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div className="section">
          <h2>Pencapaian & Kebijakan Utama</h2>
          <ul>
            <li>Stabilisasi ekonomi Rusia pasca-krisis 1998 melalui reformasi pajak dan kontrol atas oligarki</li>
            <li>Peningkatan GDP dan cadangan devisa melalui ekspor energi (minyak dan gas)</li>
            <li>Sentralisasi kekuasaan federal dan reformasi struktur pemerintahan regional</li>
            <li>Penguatan militer dan modernisasi angkatan bersenjata Rusia</li>
            <li>Kebijakan luar negeri assertif: aneksasi Krimea (2014), intervensi di Suriah (2015-sekarang)</li>
            <li>Penyelenggaraan Olimpiade Musim Dingin Sochi 2014 dan Piala Dunia FIFA 2018</li>
          </ul>
        </div>

        <div className="section">
          <h2>Kontroversi</h2>
          <ul>
            <li>Pembatasan kebebasan pers dan oposisi politik</li>
            <li>Tuduhan pelanggaran hak asasi manusia</li>
            <li>Aneksasi Krimea dan konflik Ukraina (2014-sekarang)</li>
            <li>Invasi Rusia ke Ukraina (24 Februari 2022-sekarang)</li>
            <li>Tuduhan campur tangan dalam pemilihan asing</li>
            <li>Sanksi internasional dari Uni Eropa, AS, dan sekutunya</li>
          </ul>
        </div>

        <div className="section">
          <h2>Penghargaan</h2>
          <ul>
            <li>Order of Merit for the Fatherland (beberapa kali)</li>
            <li>Order of Alexander Nevsky</li>
            <li>Berbagai penghargaan dari negara-negara sahabat</li>
            <li>Sabuk hitam 8-dan Judo (dibekukan oleh International Judo Federation, 2022)</li>
            <li>Gelar kehormatan Taekwondo 9-dan</li>
          </ul>
        </div>

        <div className="section">
          <h2>Fakta Menarik</h2>
          <ul>
            <li>Fasih berbahasa Rusia dan Jerman</li>
            <li>Praktisi Judo dan Sambo sejak usia 11 tahun</li>
            <li>Pernah menjadi anggota Partai Komunis Uni Soviet (1975-1991)</li>
            <li>Tinggi badan: sekitar 170 cm (5'7")</li>
            <li>Hobi: berburu, menunggang kuda, hockey es, dan kegiatan outdoor</li>
            <li>Pernah menyanyi untuk amal dan tampil di berbagai acara publik</li>
          </ul>
        </div>
      </section>

      <footer>
        <p>Sumber: Berbagai sumber publik dan arsip sejarah</p>
        <p className="disclaimer">Halaman ini dibuat untuk tujuan informasi dan edukasi.</p>
      </footer>
    </div>
  )
}

export default App
