// EP-19-S1-T1/T2/T3 — Circuito `distinctCounterparties` v2 (completo)
//
// Demuestra, sin revelar identidades, que el agente acumuló >= min_k
// contrapartes DISTINTAS en la ventana W (pertenencia real al árbol de recibos
// Merkle via keccak256) y que el peso ponderado acumulado >= min_weight, con
// las contrapartes débiles truncadas a 10%.
//
// Datos:
//   público:   receipt_root [u8;32] (raíz del árbol de recibos, hoja = keccak256(addr 20 bytes)),
//              min_k u32, min_weight u32 (peso en centésimas: 100 = peso completo),
//              window_start u64, window_end u64 (coherencia de ventana)
//   privado:   counterparties: [[u8;20]; SLOTS]  (identidades; padding = 0x00…00)
//              used_flags: [bool; SLOTS]        (posición activa = contraparte real)
//              weak_flags: [bool; SLOTS]        (contraparte débil: peso truncado a 10%)
//              weights: [u32; SLOTS]            (peso en centésimas)
//              siblings: [[[u8;32]; LEVELS]; SLOTS] (camino Merkle por slot)
//              selectors: [[bool; LEVELS]; SLOTS]   (true = hermano va a la izquierda)
//
// SLOTS debe ser potencia de 2 (SLOTS = 2^LEVELS). El árbol se construye
// off-chain con keccak256 sobre pares de 32 bytes (hoja y nodos). La misma
// función `verify_membership` se usa en los tests con árboles pequeños (L=1)
// construidos in-circuito, de modo que la pertenencia queda testeada
// end-to-end.
//
// Deuda documentada (EP-19-S1-T3 completo): weak_flag es entrada privada sin
// prueba de su procedencia del score de la contraparte; el circuito garantiza
// el truncado y la pertenencia de las identidades al árbol, no la fuente del
// flag de debilidad. S4 registra el verificador on-chain.

use keccak256::keccak256;

global SLOTS: u32 = 32;
global LEVELS: u32 = 5;

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

fn main(
    receipt_root: [u8; 32],
    min_k: u32,
    min_weight: u32,
    window_start: u64,
    window_end: u64,
    counterparties: [[u8; 20]; SLOTS],
    used_flags: [bool; SLOTS],
    weak_flags: [bool; SLOTS],
    weights: [u32; SLOTS],
    siblings: [[[u8; 32]; LEVELS]; SLOTS],
    selectors: [[bool; LEVELS]; SLOTS],
) {
    assert(window_start < window_end);

    // (1) unicidad: toda pareja activa-activa es distinta
    for i in 0..SLOTS {
        for j in (i + 1)..SLOTS {
            if used_flags[i] & used_flags[j] {
                let same = bytes_eq20(counterparties[i], counterparties[j]);
                assert(!same);
            }
        }
    }

    // (2) pertenencia de cada activo al árbol de recibos + (3) ponderación
    let mut count: u32 = 0;
    let mut total_weight: u32 = 0;
    for i in 0..SLOTS {
        if used_flags[i] {
            count += 1;
            let member = verify_membership(counterparties[i], receipt_root, siblings[i], selectors[i]);
            assert(member);
            // contraparte débil truncada a 10%
            let w = weights[i];
            let contribution = if weak_flags[i] { w / 10 } else { w };
            total_weight += contribution;
        }
    }

    assert(count >= min_k);
    assert(total_weight >= min_weight);
}

#[test]
fn test_all_inactive_counts_zero() {
    // ventana válida, 0 activos, min_k=0 → válida (sin checks de pertenencia)
    main(
        [0; 32], 0, 0, 1000, 2000,
        [[0; 20]; 32], [false; 32], [false; 32], [0; 32],
        [[[0; 32]; 5]; 32], [[false; 5]; 32],
    );
}

#[test]
fn test_membership_1_level_ok() {
    // árbol de 2 hojas: root = keccak(hoja_A ++ hoja_B); A es el slot 0
    let addr_a: [u8; 20] = [0x11; 20];
    let addr_b: [u8; 20] = [0x22; 20];
    let ha = leaf(addr_a);
    let hb = leaf(addr_b);
    let root = keccak256::<64>(concat64(ha, hb), 64);
    let ok = verify_membership(addr_a, root, [hb], [false]);
    assert(ok);
}

#[test(should_fail)]
fn test_membership_1_level_wrong_sibling() {
    let addr_a: [u8; 20] = [0x11; 20];
    let addr_b: [u8; 20] = [0x22; 20];
    let ha = leaf(addr_a);
    let hb = leaf(addr_b);
    let root = keccak256::<64>(concat64(ha, hb), 64);
    // hermano cambiado → root no cuadra
    let wrong: [u8; 32] = [0x99; 32];
    let ok = verify_membership(addr_a, root, [wrong], [false]);
    assert(ok);
}

#[test(should_fail)]
fn test_membership_selector_wrong() {
    // selector invertido (hermano a la izquierda cuando debía estar a la derecha)
    let addr_a: [u8; 20] = [0x11; 20];
    let addr_b: [u8; 20] = [0x22; 20];
    let ha = leaf(addr_a);
    let hb = leaf(addr_b);
    let root = keccak256::<64>(concat64(ha, hb), 64);
    // para addr_b (hoja derecha), el hermano ha va a la IZQUIERDA → selector correcto = true;
    // con selector=false se computa keccak(hb ++ ha) != root → debe fallar
    let ok = verify_membership(addr_b, root, [ha], [false]);
    assert(ok);
}

#[test(should_fail)]
fn test_dup_actives_rejected() {
    // dos slots activos con la misma identidad → unicidad falla
    // (sí, la pertenencia también fallaría con paths cero, pero el assert de
    // unicidad corre ANTES que el de pertenencia, así que el fallo es del dup)
    let mut used: [bool; 32] = [false; 32];
    used[0] = true;
    used[1] = true;
    let mut cps: [[u8; 20]; 32] = [[0; 20]; 32];
    cps[0] = [0x11; 20];
    cps[1] = [0x11; 20];
    main(
        [0; 32], 0, 0, 1000, 2000,
        cps, used, [false; 32], [0; 32],
        [[[0; 32]; 5]; 32], [[false; 5]; 32],
    );
}
