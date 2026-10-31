import QtQuick
import QtQuick.Layouts
import Quickshell
import qs
import qs.services
import qs.modules.common
import qs.modules.common.widgets

// DiDae — provider Dae Captain untuk DynamicIsland end4.
// Taruh file ini sejajar dengan DiIdle.qml dkk, lalu tambah patch dari PATCH.md.
Item {
    id: diDaeRoot

    required property Item di

    anchors.fill: parent

    // warna status: hijau idle, biru jalan, merah gagal, abu offline
    readonly property color statusColor: !di.daeServerUp ? Appearance.colors.colOutline
        : di.daeFailed > 0 ? Appearance.colors.colError
        : di.daeRunning > 0 ? Appearance.colors.colPrimary
        : Appearance.colors.colSecondary

    readonly property string statusText: !di.daeServerUp ? "Dae offline"
        : di.daeFailed > 0 ? `${di.daeFailed} gagal`
        : di.daeRunning > 0 ? `${di.daeRunning} jalan`
        : "Dae idle"

    RowLayout {
        anchors {
            fill: parent
            leftMargin: di.isMaterial ? 4 : 8
            rightMargin: 10
        }
        spacing: 8

        // maskot: lingkaran + ikon
        Rectangle {
            Layout.alignment: Qt.AlignVCenter
            width: di.isMaterial ? di.pillHeight : di.pillHeight - 8
            height: di.isMaterial ? di.pillHeight : di.pillHeight - 8
            radius: width / 2
            color: diDaeRoot.statusColor
            MaterialSymbol {
                anchors.centerIn: parent
                text: "smart_toy"
                iconSize: parent.width * 0.55
                color: Appearance.colors.colOnPrimary
            }
        }

        StyledText {
            Layout.alignment: Qt.AlignVCenter
            text: diDaeRoot.statusText
            font.pixelSize: Appearance.font.pixelSize.small
            font.weight: Font.DemiBold
            font.features: { "tnum": 1 }
            color: Appearance.colors.colOnLayer0
        }

        Item { Layout.fillWidth: true }

        // tombol: buka panel Dae Captain
        MaterialSymbol {
            Layout.alignment: Qt.AlignVCenter
            text: "open_in_new"
            iconSize: Appearance.font.pixelSize.normal
            color: Appearance.colors.colOnLayer0
        }
    }

    MouseArea {
        anchors.fill: parent
        cursorShape: Qt.PointingHandCursor
        onClicked: {
            // fokus window Dae Captain, atau jalankan kalau belum ada
            Quickshell.execDetached(["sh", "-c",
                "hyprctl dispatch focuswindow 'title:Dae Captain' 2>/dev/null || dae-captain &"]);
        }
    }

    // lebar expand mengikuti konten (dipakai provider width)
    readonly property real computedDaeWidth: 8 + (di.isMaterial ? di.pillHeight : di.pillHeight - 8)
        + 8 + 90 + 8 + 20 + 10
}
