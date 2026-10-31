# Patch DynamicIsland.qml end4 untuk provider Dae

File `DynamicIsland.qml` end4 tidak diubah otomatis — tempel manual 3 bagian ini.
Cari teks "CARI:" lalu tempel blok "TEMPEL:" di dekatnya.

---

## 1. State + poller (di root Item)

CARI:
```
    readonly property bool isRecording: Persistent.states.record.enable
```

TEMPEL setelahnya:
```qml
    // --- Dae Captain ---
    property bool daeServerUp: false
    property int daeRunning: 0
    property int daeFailed: 0
    readonly property bool daeHasActivity: daeServerUp && (daeRunning > 0 || daeFailed > 0)
    readonly property real daeWidth: 190

    function daeRefresh() {
        var xhr = new XMLHttpRequest();
        xhr.open("GET", "http://127.0.0.1:3080/tasks");
        xhr.timeout = 1500;
        xhr.onreadystatechange = function() {
            if (xhr.readyState !== XMLHttpRequest.DONE) return;
            if (xhr.status === 200) {
                root.daeServerUp = true;
                try {
                    var data = JSON.parse(xhr.responseText);
                    var list = Array.isArray(data) ? data : (data.tasks || []);
                    var r = 0, f = 0;
                    for (var i = 0; i < list.length; i++) {
                        if (list[i].status === "running") r++;
                        else if (list[i].status === "failed") f++;
                    }
                    root.daeRunning = r;
                    root.daeFailed = f;
                } catch (e) {}
            } else {
                root.daeServerUp = false;
            }
        };
        xhr.onerror = function() { root.daeServerUp = false; };
        xhr.send();
    }
```

CARI blok `Timer {` pertama untuk recording, TEMPEL timer baru di dekatnya:
```qml
    Timer {
        id: daePollTimer
        interval: 2000
        repeat: true
        running: true
        triggeredOnStart: true
        onTriggered: root.daeRefresh()
    }
```

---

## 2. Daftarkan provider

CARI:
```
        { id: "session", active: GlobalStates.diSessionOpen, component: sessionComponent, width: root.sessionWidth },
```

TEMPEL setelahnya:
```qml
        { id: "dae", active: root.daeHasActivity, component: daeComponent, width: root.daeWidth },
```

CATATAN: `active: root.daeHasActivity` = island hanya expand saat ada task
jalan/gagal. Kalau mau maskot selalu tampil, ganti jadi `active: true`
(tapi idle bawaan end4 ketimpa).

---

## 3. Daftarkan komponen

CARI:
```
    Component {
        id: sessionComponent
        DiSession { di: root }
    }
```

TEMPEL setelahnya:
```qml
    Component {
        id: daeComponent
        DiDae { di: root }
    }
```

---

## 4. (Opsional) ikon badge saat Dae bukan provider aktif

CARI fungsi `iconForProviderId`, tambah case:
```qml
            case "dae": return "smart_toy"
```

---

## 5. Taruh file

```bash
cp DiDae.qml ~/.config/quickshell/ii/bar/DiDae.qml
# sesuaikan path dengan lokasi config quickshell-mu
```

Restart quickshell (`qs -r` atau kill + jalankan ulang). Selesai.
