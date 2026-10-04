use teloxide::utils::command::BotCommands;

#[derive(BotCommands, Clone, Debug)]
#[command(rename_rule = "lowercase", description = "Perintah yang didukung:")]
pub enum Command {
    #[command(description = "Mulai bot dan tampilkan panduan.")]
    Start,
    #[command(description = "Tampilkan panduan perintah.")]
    Help,
    #[command(description = "Tampilkan menu interaktif.")]
    Menu,
    #[command(description = "Status sesi dan model aktif.")]
    Status,
    #[command(description = "Sematkan status live sesi di chat.")]
    Pin,
    #[command(description = "Buat sesi baru: /new [path]")]
    New(String),
    #[command(description = "Daftar sesi yang tersedia.")]
    Sessions,
    #[command(description = "Riwayat percakapan sesi.")]
    History,
    #[command(description = "Lihat atau ganti model: /model [name]")]
    Model(String),
    #[command(description = "Ganti nama sesi: /rename <nama>")]
    Rename(String),
    #[command(description = "Tanya sekilas tanpa menambah context: /side <pertanyaan>")]
    Side(String),
    #[command(description = "Daftar subagent di sesi aktif.")]
    Subagents,
    #[command(description = "Ekspor transkrip percakapan ke file.")]
    Export,
    #[command(description = "Atur level thinking / reasoning model.")]
    Thinking,
    #[command(description = "Pantau sesi yang sedang berjalan di web/cli.")]
    Track,
    #[command(description = "Jalankan terminal shell: /sh <command>")]
    Sh(String),
    #[command(description = "Tampilkan git diff sesi.")]
    Diff,
    #[command(description = "Lakukan context compaction sesi.")]
    Compact,
    #[command(description = "Jelajahi file direktori sesi: /ls [path]")]
    Ls(String),
    #[command(description = "Daftar jadwal cron jobs.")]
    Tasks,
    #[command(description = "Ubah lean-ctx context profile: /ctx-mode [profile]")]
    #[command(rename = "ctx-mode")]
    CtxMode(String),
    #[command(description = "Ubah lean-ctx tool profile: /ctx-tools [profile]")]
    #[command(rename = "ctx-tools")]
    CtxTools(String),
    #[command(description = "Hentikan pembuatan pesan.")]
    Abort,
}
