const { SlashCommandBuilder, PermissionFlagsBits } = require("discord.js");

const commands = [
  new SlashCommandBuilder()
    .setName("subscribe")
    .setDescription("このチャンネルにイベントボーダー通知を登録します（両方Falseで解除）")
    .addBooleanOption((opt) =>
      opt
        .setName("now_border")
        .setDescription("最新ボーダー（ドリーム級・ダイヤ級・プラチナ級）をテキストで通知するか")
        .setRequired(true)
    )
    .addBooleanOption((opt) =>
      opt
        .setName("border_prediction")
        .setDescription("着地予測レポート画像を添付して通知するか")
        .setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),

  new SlashCommandBuilder()
    .setName("unsubscribe")
    .setDescription("このチャンネルのイベントボーダー通知を解除します")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
];

module.exports = { commands };
