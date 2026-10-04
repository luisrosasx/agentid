// EP-19-S1 (MVP v1) — Circuito `distinctCounterparties`
//
// Demostración ZK de que el agente acumuló >= min_k contrapartes DISTINTAS en la
// ventana W, sin revelar las identidades. MVP v1: unicidad por comparación
// pairwise de las posiciones activas (32^2 = 1024 constraints, aceptable);
// la pertenencia al árbol de recibos (Merkle proof de cada identidad contra
// receiptRoot) y la ponderación de contrapartes débiles (<=10%) quedan como
// siguiente paso (EP-19-S1-T1/T3).
//
// Inputs:
//   públicos:  min_k, receipt_root (reservado), window_start, window_end (reservados)
//   privados:  counterparties[] (identidades como Field), used_flags[] (1 si la
//              posición es una contraparte real del lote)
//
// Restricciones:
//   1. Ventana coherente (window_start < window_end).
//   2. Toda pareja de posiciones ACTIVAS tiene identidades distintas (unicidad).
//   3. El número de flags=1 es >= min_k.

fn main(
    min_k: u32,
    receipt_root: pub Field,
    window_start: pub u64,
    window_end: pub u64,
    counterparties: [Field; 32],
    used_flags: [bool; 32],
) {
    assert(window_start < window_end);

    // (2) unicidad: toda pareja activa-activa es distinta (equality sobre Field sí está permitido)
    for i in 0..32 {
        for j in (i + 1)..32 {
            if used_flags[i] & used_flags[j] {
                assert(counterparties[i] != counterparties[j]);
            }
        }
    }

    // (3) conteo >= min_k
    let mut count: u32 = 0;
    for i in 0..32 {
        count += if used_flags[i] { 1 } else { 0 };
    }
    assert(count >= min_k);
}


#[test]
fn test_distinct_k() {
    let mut cps: [Field; 32] = [0; 32];
    let mut flags: [bool; 32] = [false; 32];
    // 5 contrapartes distintas
    cps[0] = 1; cps[1] = 2; cps[2] = 3; cps[3] = 4; cps[4] = 5;
    for i in 0..5 { flags[i] = true; }
    main(5, 0, 1000, 2000, cps, flags);
}


#[test(should_fail)]
fn test_duplicated_k() {
    let mut cps: [Field; 32] = [0; 32];
    let mut flags: [bool; 32] = [false; 32];
    // duplicado dentro del rango activo → debe fallar
    cps[0] = 1; cps[1] = 1; cps[2] = 2; cps[3] = 3; cps[4] = 4;
    for i in 0..5 { flags[i] = true; }
    main(5, 0, 1000, 2000, cps, flags);
}


#[test(should_fail)]
fn test_too_few_k() {
    let mut cps: [Field; 32] = [0; 32];
    let mut flags: [bool; 32] = [false; 32];
    cps[0] = 1; cps[1] = 2;
    for i in 0..2 { flags[i] = true; }
    main(5, 0, 1000, 2000, cps, flags);
}


#[test]
fn test_inactive_duplicates_ok() {
    // duplicados en posiciones INACTIVAS no cuentan ni deben fallar
    let mut cps: [Field; 32] = [7; 32];
    let mut flags: [bool; 32] = [false; 32];
    cps[0] = 1; cps[1] = 2; cps[2] = 3;
    for i in 0..3 { flags[i] = true; }
    main(3, 0, 1000, 2000, cps, flags);
}
