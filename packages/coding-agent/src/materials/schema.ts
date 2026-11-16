/** Independent schema versioning: the existing debt tables remain intact. */
export const MATERIAL_SCHEMA_VERSION = 1;
export const MATERIAL_SCHEMA = [
	`CREATE TABLE IF NOT EXISTS material_meta (
		\`key\` VARCHAR(191) PRIMARY KEY, \`value\` VARCHAR(191) NOT NULL
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
	`CREATE TABLE IF NOT EXISTS materials (
		id VARCHAR(36) PRIMARY KEY, kind VARCHAR(16) NOT NULL,
		title VARCHAR(512) NOT NULL, source_type VARCHAR(64) NOT NULL,
		identity_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
		latest_snapshot_id VARCHAR(36), created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL,
		INDEX idx_material_created (created_at, id)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
	`CREATE TABLE IF NOT EXISTS material_links (
		material_id VARCHAR(36) PRIMARY KEY, url TEXT NOT NULL,
		FOREIGN KEY (material_id) REFERENCES materials(id)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
	`CREATE TABLE IF NOT EXISTS material_texts (
		material_id VARCHAR(36) PRIMARY KEY, content LONGTEXT NOT NULL,
		FOREIGN KEY (material_id) REFERENCES materials(id)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
	`CREATE TABLE IF NOT EXISTS material_snapshots (
		id VARCHAR(36) PRIMARY KEY, material_id VARCHAR(36) NOT NULL,
		content LONGTEXT NOT NULL, content_type VARCHAR(32) NOT NULL,
		content_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
		extractor VARCHAR(191) NOT NULL, created_at BIGINT NOT NULL,
		UNIQUE KEY uq_snapshot (material_id, content_hash, content_type, extractor),
		FOREIGN KEY (material_id) REFERENCES materials(id)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
	`CREATE TABLE IF NOT EXISTS material_assets (
		id VARCHAR(36) PRIMARY KEY, material_id VARCHAR(36) NOT NULL,
		sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
		byte_size BIGINT UNSIGNED NOT NULL, content_type VARCHAR(127) NOT NULL,
		file_name VARCHAR(512) NOT NULL, role VARCHAR(32) NOT NULL,
		position INT UNSIGNED NOT NULL, source_url TEXT, created_at BIGINT NOT NULL,
		UNIQUE KEY uq_material_asset_position (material_id, role, position),
		FOREIGN KEY (material_id) REFERENCES materials(id)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
	`CREATE TABLE IF NOT EXISTS material_debts (
		debt_id VARCHAR(36) NOT NULL, material_id VARCHAR(36) NOT NULL,
		PRIMARY KEY (debt_id, material_id),
		FOREIGN KEY (debt_id) REFERENCES debt_items(id),
		FOREIGN KEY (material_id) REFERENCES materials(id)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
];
