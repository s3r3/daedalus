/**
 * Template dokumen bawaan Dae Captain (Fase C / desain 4.1): makalah,
 * laporan, proposal, dan surat resmi. Seperti template Slide, tapi untuk
 * dokumen: user pilih template → kerangka (outline) otomatis terisi
 * mengikuti struktur template. Tiap template = daftar section dengan
 * judul + prompt isi (contentPrompt) yang dipakai sebagai thesisPoints
 * saat kerangka di-stage via POST /dokumen/outline.
 */

export type DocumentTemplateId = 'makalah' | 'laporan' | 'proposal' | 'surat-resmi';

export type DocumentTemplateSection = {
  /** Judul section, mis. "Pendahuluan". */
  title: string;
  /** Prompt isi: panduan satu-dua kalimat tentang apa yang ditulis di section ini. */
  contentPrompt: string;
};

export type DocumentTemplate = {
  id: DocumentTemplateId;
  name: string;
  description: string;
  sections: DocumentTemplateSection[];
};

export const DOCUMENT_TEMPLATES: readonly DocumentTemplate[] = [
  {
    id: 'makalah',
    name: 'Makalah',
    description: 'Struktur akademik: abstrak, pendahuluan, pembahasan, penutup, daftar pustaka.',
    sections: [
      {
        title: 'Judul & Identitas',
        contentPrompt: 'Tulis judul makalah yang jelas dan spesifik, diikuti nama penulis, afiliasi/institusi, dan tanggal penulisan.',
      },
      {
        title: 'Abstrak',
        contentPrompt: 'Ringkasan 150–250 kata: latar belakang masalah, tujuan, metode singkat, hasil utama, dan kesimpulan. Ditulis dalam satu paragraf padat.',
      },
      {
        title: 'Pendahuluan',
        contentPrompt: 'Uraikan latar belakang masalah, rumusan masalah, tujuan penulisan, dan batasan/ruang lingkup makalah.',
      },
      {
        title: 'Pembahasan',
        contentPrompt: 'Jabarkan analisis utama dalam beberapa subbab: konsep/teori yang dipakai, data atau argumen pendukung, serta pembahasan kritis terhadap temuan.',
      },
      {
        title: 'Penutup',
        contentPrompt: 'Simpulkan jawaban atas rumusan masalah (Kesimpulan), lalu berikan saran tindak lanjut atau penelitian berikutnya (Saran).',
      },
      {
        title: 'Daftar Pustaka',
        contentPrompt: 'Daftar semua sumber yang dirujuk dengan format sitasi yang konsisten (APA/IEEE). Setiap sitasi yang muncul di teks harus ada di sini.',
      },
    ],
  },
  {
    id: 'laporan',
    name: 'Laporan',
    description: 'Laporan kegiatan/proyek: ringkasan eksekutif, metodologi, hasil, analisis, rekomendasi.',
    sections: [
      {
        title: 'Ringkasan Eksekutif',
        contentPrompt: 'Ringkasan satu halaman untuk pembaca sibuk: konteks kegiatan, hasil terpenting (dengan angka), dan rekomendasi utama.',
      },
      {
        title: 'Latar Belakang',
        contentPrompt: 'Jelaskan konteks dan alasan kegiatan/proyek ini dilakukan, termasuk masalah yang ingin diselesaikan.',
      },
      {
        title: 'Metodologi',
        contentPrompt: 'Uraikan cara kerja: tahapan kegiatan, metode pengumpulan data, alat yang dipakai, dan periode pelaksanaan.',
      },
      {
        title: 'Hasil & Temuan',
        contentPrompt: 'Sajikan hasil secara faktual: data, tabel/grafik, dan temuan lapangan — tanpa interpretasi dulu di sini.',
      },
      {
        title: 'Analisis',
        contentPrompt: 'Interpretasikan hasil: apa artinya angka/temuan tersebut, pola yang muncul, dan perbandingan dengan target atau periode sebelumnya.',
      },
      {
        title: 'Kesimpulan & Rekomendasi',
        contentPrompt: 'Simpulkan pencapaian terhadap tujuan awal, lalu berikan rekomendasi konkret yang bisa ditindaklanjuti beserta prioritasnya.',
      },
      {
        title: 'Lampiran',
        contentPrompt: 'Dokumen pendukung: data mentah, foto kegiatan, surat tugas, atau rincian anggaran yang terlalu detail untuk badan laporan.',
      },
    ],
  },
  {
    id: 'proposal',
    name: 'Proposal',
    description: 'Proposal kegiatan/penelitian: latar belakang, rumusan masalah, tujuan, metode, anggaran & jadwal.',
    sections: [
      {
        title: 'Judul',
        contentPrompt: 'Judul proposal yang mencerminkan kegiatan/penelitian yang diusulkan — spesifik, tidak terlalu panjang.',
      },
      {
        title: 'Latar Belakang',
        contentPrompt: 'Uraikan urgensi: fakta/data yang menunjukkan masalah ini penting dan perlu ditangani sekarang.',
      },
      {
        title: 'Rumusan Masalah',
        contentPrompt: 'Rumuskan masalah dalam bentuk pertanyaan yang jelas dan terukur — inilah yang akan dijawab kegiatan ini.',
      },
      {
        title: 'Tujuan & Manfaat',
        contentPrompt: 'Tulis tujuan umum dan tujuan khusus (terukur), lalu manfaat bagi pihak-pihak terkait.',
      },
      {
        title: 'Tinjauan Pustaka',
        contentPrompt: 'Rangkum teori, penelitian, atau kegiatan sejenis yang sudah ada sebagai landasan usulan ini.',
      },
      {
        title: 'Metodologi',
        contentPrompt: 'Jelaskan rencana pelaksanaan: tahapan, metode, sasaran/peserta, lokasi, dan indikator keberhasilan.',
      },
      {
        title: 'Rencana Anggaran & Jadwal',
        contentPrompt: 'Rincian biaya per komponen (uraian, volume, harga satuan, jumlah) dan jadwal kegiatan dalam bentuk tabel timeline.',
      },
      {
        title: 'Daftar Pustaka',
        contentPrompt: 'Sumber rujukan dengan format sitasi yang konsisten.',
      },
    ],
  },
  {
    id: 'surat-resmi',
    name: 'Surat Resmi',
    description: 'Format surat dinas/instansi: kop, nomor & perihal, alamat tujuan, isi, penutup, tanda tangan.',
    sections: [
      {
        title: 'Kop Surat',
        contentPrompt: 'Nama instansi/perusahaan, alamat lengkap, nomor telepon, email, dan logo di bagian atas surat.',
      },
      {
        title: 'Nomor, Tanggal & Perihal',
        contentPrompt: 'Nomor surat sesuai tata naskah instansi, tempat & tanggal surat, jumlah lampiran, dan perihal yang singkat-jelas.',
      },
      {
        title: 'Alamat Tujuan',
        contentPrompt: 'Ditujukan kepada (Yth.), nama penerima/jabatan, nama instansi, dan alamat lengkap penerima.',
      },
      {
        title: 'Salam Pembuka & Maksud',
        contentPrompt: 'Salam pembuka ("Dengan hormat,") diikuti satu paragraf maksud surat: kenapa surat ini ditulis.',
      },
      {
        title: 'Isi Surat',
        contentPrompt: 'Uraian pokok surat dalam bahasa baku yang lugas: fakta, permintaan, atau pemberitahuan — satu gagasan per paragraf.',
      },
      {
        title: 'Penutup',
        contentPrompt: 'Salam penutup ("Demikian disampaikan, atas perhatian Bapak/Ibu kami ucapkan terima kasih.") dalam satu paragraf singkat.',
      },
      {
        title: 'Tanda Tangan',
        contentPrompt: 'Nama terang penandatangan, NIP (bila instansi pemerintah), dan jabatan di bawah ruang tanda tangan.',
      },
    ],
  },
];

/** Semua template bawaan (salinan agar pemanggil tidak bisa mengubah konstanta). */
export function listDocumentTemplates(): DocumentTemplate[] {
  return DOCUMENT_TEMPLATES.map((t) => ({ ...t, sections: t.sections.map((s) => ({ ...s })) }));
}

export function getDocumentTemplate(id: string): DocumentTemplate | undefined {
  return listDocumentTemplates().find((t) => t.id === id);
}

/**
 * Ubah template menjadi baris kerangka untuk POST /dokumen/outline:
 * judul section + contentPrompt sebagai thesisPoints (panduan isi yang
 * bisa disunting di panel sebelum tombol Buat ditekan).
 */
export function templateOutlineSections(template: DocumentTemplate): Array<{ title: string; thesisPoints: string[] }> {
  return template.sections.map((s) => ({ title: s.title, thesisPoints: [s.contentPrompt] }));
}
