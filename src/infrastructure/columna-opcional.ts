/**
 * ADR-220 D-220.7 — ¿existe esta columna en esta base?
 *
 * Nace de una avería medida, no de prudencia genérica. `main` de este repo escribe
 * `INSERT INTO documents (..., brand_slugs)` SIN comprobar nada, y la migración que crea esa
 * columna (013) resultó ser inaplicable en los dos planos: el compiler COMPARTIDO quedó con
 * `/v1/ingest` roto por construcción, y el de tenant1 sólo se salvó porque su imagen estaba
 * clavada en un SHA anterior — cualquier redespliegue suyo lo rompía también.
 *
 * El modo de fallo es el peor de los tres posibles: una migración que no se puede aplicar no
 * avisa, y el código que la presupone tampoco, hasta que alguien ingiere.
 *
 * `project_slugs` NO repite eso: se escribe sólo donde la columna existe, y la instancia sin
 * migrar sigue ingiriendo — con el documento sin acotar, que es la degradación correcta del
 * ESCRITOR (visible y corregible reetiquetando) y la contraria a la del LECTOR.
 *
 * Se consulta el catálogo en cada ingesta y NO se cachea a propósito. Una caché de proceso
 * sobreviviría a la migración y dejaría al compiler creyendo durante horas que la columna no
 * existe, justo después de crearla; el coste es una lectura indexada de `pg_attribute` al lado
 * de un batch de embeddings. `pg_attribute` y no `information_schema`: el segundo filtra por
 * privilegios del rol que consulta, así que puede decir «no existe» cuando lo que pasa es que
 * no la ves — es la trampa que ya costó una sesión en este programa.
 */

/** Cliente mínimo: cualquier `pg.Client` o `pg.PoolClient` sirve. */
export interface ConsultaCatalogo {
  query(sql: string, params: unknown[]): Promise<{ rows: unknown[] }>;
}

export async function columnaExiste(
  client: ConsultaCatalogo,
  tabla: string,
  columna: string
): Promise<boolean> {
  // `to_regclass` resuelve por `search_path`, que es exactamente la tabla contra la que va a
  // escribir el INSERT de al lado. Buscar por un esquema fijo daría la respuesta de otra tabla.
  const { rows } = await client.query(
    `SELECT 1
       FROM pg_attribute
      WHERE attrelid = to_regclass($1)
        AND attname = $2
        AND NOT attisdropped
        AND attnum > 0`,
    [tabla, columna]
  );
  return rows.length > 0;
}
