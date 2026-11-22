// Options added by this fork, stored as one JSON text so later options need no further migration.
exports.up = async (knex) => {
    await knex.schema.alterTable("monitor", (table) => {
        table.text("fork_options");
    });
};

exports.down = async (knex) => {
    await knex.schema.alterTable("monitor", (table) => {
        table.dropColumn("fork_options");
    });
};
