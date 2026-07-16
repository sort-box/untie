const { DatabaseSync } = require("node:sqlite");

class NodeSqliteIndexAdapter {
	constructor(filename) {
		this.database = new DatabaseSync(filename);
	}

	exec(sql) {
		return this.database.exec(sql);
	}

	prepare(sql) {
		return this.database.prepare(sql);
	}

	close() {
		this.database.close();
	}
}

function createNodeSqliteIndexAdapter(filename) {
	return new NodeSqliteIndexAdapter(filename);
}

module.exports = { createNodeSqliteIndexAdapter };
