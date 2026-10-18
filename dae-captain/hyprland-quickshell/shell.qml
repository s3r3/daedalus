import QtQuick
import QtQuick.Layouts
import Quickshell
import Quickshell.Wayland

// Dae Captain Dynamic Island untuk Hyprland
// Poll server Dae Captain (127.0.0.1:3080) tiap 2 detik.
// Klik pill -> toggle panel Tauri (via qdbus/hyprctl atau buka app).

ShellRoot {
    PanelWindow {
        id: island

        anchors {
            top: true
            left: true
            right: true
        }
        margins { top: 10 }

        // Jangan ambil ruang bar; ngambang di atas semua window.
        exclusionMode: ExclusionMode.Ignore
        WlrLayershell.layer: WlrLayer.Overlay
        WlrLayershell.keyboardFocus: WlrKeyboardFocus.None

        implicitWidth: pill.width
        implicitHeight: pill.height
        color: "transparent"

        // --- state ---
        property int running: 0
        property int failed: 0
        property bool serverUp: false

        function refresh() {
            var xhr = new XMLHttpRequest();
            xhr.open("GET", "http://127.0.0.1:3080/tasks");
            xhr.timeout = 1500;
            xhr.onreadystatechange = function() {
                if (xhr.readyState !== XMLHttpRequest.DONE) return;
                if (xhr.status === 200) {
                    island.serverUp = true;
                    try {
                        var tasks = JSON.parse(xhr.responseText);
                        var r = 0, f = 0;
                        var list = Array.isArray(tasks) ? tasks : (tasks.tasks || []);
                        for (var i = 0; i < list.length; i++) {
                            var s = list[i].status;
                            if (s === "running") r++;
                            else if (s === "failed") f++;
                        }
                        island.running = r;
                        island.failed = f;
                    } catch (e) { /* abaikan */ }
                } else {
                    island.serverUp = false;
                }
            };
            xhr.onerror = function() { island.serverUp = false; };
            xhr.send();
        }

        Timer {
            interval: 2000
            running: true
            repeat: true
            triggeredOnStart: true
            onTriggered: island.refresh()
        }

        // --- pill ---
        Rectangle {
            id: pill
            anchors.horizontalCenter: parent.horizontalCenter
            width: row.width + 32
            height: 40
            radius: 20
            color: island.serverUp
                ? (island.failed > 0 ? "#3a1d1d" : island.running > 0 ? "#1d2b3a" : "#1c1c22")
                : "#2a2a2a"
            border.color: island.serverUp ? "#5a5a6a" : "#444"
            border.width: 1

            RowLayout {
                id: row
                anchors.centerIn: parent
                spacing: 8

                // dot status
                Rectangle {
                    width: 12; height: 12; radius: 6
                    color: !island.serverUp ? "#666"
                        : island.failed > 0 ? "#ff5f57"
                        : island.running > 0 ? "#5ac8fa" : "#9ece6a"
                    Layout.alignment: Qt.AlignVCenter
                }

                Text {
                    text: !island.serverUp ? "Dae offline"
                        : island.running > 0 ? "Dae • " + island.running + " jalan"
                        : island.failed > 0 ? "Dae • " + island.failed + " gagal"
                        : "Dae Captain"
                    color: "#e8e8ec"
                    font.pixelSize: 14
                    Layout.alignment: Qt.AlignVCenter
                }
            }

            MouseArea {
                anchors.fill: parent
                cursorShape: Qt.PointingHandCursor
                onClicked: {
                    // Toggle panel Tauri: panggil command via Quickshell.exec
                    // Ganti dengan cara toggle yang kamu pakai.
                    Quickshell.execDetached(["sh", "-c",
                        "hyprctl dispatch focuswindow 'title:Dae Captain' || dae-captain"]);
                }
            }
        }
    }
}
