// EP-19-S2 — Circuito de bench: lote ≤1k recibos, 64 contrapartes activas
// (mismo pipeline que distinct_counterparties_v2, sin slots de padding:
// N_ACTIVE=64 con paths de 10 niveles sobre árbol de 1024 hojas)

use keccak256::keccak256;

global N_ACTIVE: u32 = 64;
global LEVELS: u32 = 10;

fn keccak32(a: [u8; 32]) -> [u8; 32] {
    keccak256::<32>(a, 32)
}

fn bytes_eq(a: [u8; 32], b: [u8; 32]) -> bool {
    let mut eq = true;
    for i in 0..32 {
        eq = eq & (a[i] == b[i]);
    }
    eq
}

fn bytes_eq20(a: [u8; 20], b: [u8; 20]) -> bool {
    let mut eq = true;
    for i in 0..20 {
        eq = eq & (a[i] == b[i]);
    }
    eq
}

// Concatena dos bloques de 32 bytes en uno de 64 (orden izq-derecha)
fn concat64(left: [u8; 32], right: [u8; 32]) -> [u8; 64] {
    let mut out: [u8; 64] = [0; 64];
    for i in 0..32 {
        out[i] = left[i];
        out[i + 32] = right[i];
    }
    out
}

// Hoja del árbol: keccak256 de la identidad (20 bytes de dirección)
fn leaf(addr: [u8; 20]) -> [u8; 32] {
    keccak256::<20>(addr, 20)
}

// Verifica la pertenencia de una hoja (addr 20 bytes) a un árbol con raíz
// root y LEVELS genérico (independiente del tamaño del programa)
fn verify_membership<let L: u32>(
    addr: [u8; 20],
    root: [u8; 32],
    siblings: [[u8; 32]; L],
    selectors: [bool; L],
) -> bool {
    let mut h: [u8; 32] = leaf(addr);
    for l in 0..L {
        let sib = siblings[l];
        h = if selectors[l] {
            keccak256::<64>(concat64(sib, h), 64)
        } else {
            keccak256::<64>(concat64(h, sib), 64)
        };
    }
    bytes_eq(h, root)
}


// Peso ponderado: contraparte débil truncada a 10%
fn weight_contribution(w: u32, weak: bool) -> u32 {
    if weak { w / 10 } else { w }
}
fn main(
    receipt_root: pub [u8; 32],
    min_k: pub u32,
    min_weight: pub u32,
    window_start: pub u64,
    window_end: pub u64,
    counterparties: [[u8; 20]; N_ACTIVE],
    weak_flags: [bool; N_ACTIVE],
    weights: [u32; N_ACTIVE],
    siblings: [[[u8; 32]; LEVELS]; N_ACTIVE],
    selectors: [[bool; LEVELS]; N_ACTIVE],
) {
    assert(window_start < window_end);

    // (1) unicidad: toda pareja de contrapartes es distinta
    for i in 0..N_ACTIVE {
        for j in (i + 1)..N_ACTIVE {
            let same = bytes_eq20(counterparties[i], counterparties[j]);
            assert(!same);
        }
    }

    // (2) pertenencia de cada contraparte al árbol de recibos + (3) ponderación
    let mut total_weight: u32 = 0;
    for i in 0..N_ACTIVE {
        let member = verify_membership(counterparties[i], receipt_root, siblings[i], selectors[i]);
        assert(member);
        total_weight += weight_contribution(weights[i], weak_flags[i]);
    }

    assert(N_ACTIVE >= min_k);
    assert(total_weight >= min_weight);
}
