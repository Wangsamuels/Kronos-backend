//! Attestation logic shared by the SP1 guest program and mirrored by the TypeScript attestor.

/// One price observation of an asset from one source, WAD-scaled (1e18 = $1).
#[derive(Clone, Copy, Debug)]
pub struct Sample {
    pub ts: u64,
    pub price: u128,
}

#[derive(Clone, Debug)]
pub struct AssetInput {
    /// samples per source over the TWAP window (e.g. Chainlink, Pyth, DEX)
    pub sources: Vec<Vec<Sample>>,
    /// the protocol's current spot price
    pub spot: u128,
}

#[derive(Clone, Debug)]
pub struct Input {
    pub assets: Vec<AssetInput>,
    pub total_assets: u128,
    pub total_liabilities: u128,
    pub max_deviation_bps: u128,
    pub min_sources: usize,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Output {
    pub oracle_ok: bool,
    pub solvency_ok: bool,
    pub twaps: Vec<u128>,
}

/// Median: robust to a short pump inside the window.
pub fn median(mut xs: Vec<u128>) -> u128 {
    if xs.is_empty() {
        return 0;
    }
    xs.sort_unstable();
    xs[xs.len() / 2]
}

fn within(a: u128, b: u128, bps: u128) -> bool {
    if b == 0 {
        return false;
    }
    let diff = if a > b { a - b } else { b - a };
    diff.saturating_mul(10_000) <= b.saturating_mul(bps)
}

pub fn attest(i: &Input) -> Output {
    let mut oracle_ok = true;
    let mut twaps = Vec::with_capacity(i.assets.len());
    for a in &i.assets {
        let per_source: Vec<u128> = a.sources.iter().map(|s| median(s.iter().map(|x| x.price).collect())).filter(|p| *p > 0).collect();
        let twap = median(per_source.clone());
        // sources must agree with each other and the spot must agree with the TWAP
        let agree = per_source.len() >= i.min_sources && per_source.iter().all(|p| within(*p, twap, i.max_deviation_bps));
        if !agree || !within(a.spot, twap, i.max_deviation_bps) {
            oracle_ok = false;
        }
        twaps.push(twap);
    }
    Output { oracle_ok, solvency_ok: i.total_assets >= i.total_liabilities, twaps }
}

#[cfg(test)]
mod tests {
    use super::*;
    const WAD: u128 = 1_000_000_000_000_000_000;

    fn src(prices: &[u128]) -> Vec<Sample> {
        prices.iter().enumerate().map(|(k, p)| Sample { ts: k as u64, price: *p }).collect()
    }

    #[test]
    fn healthy_market_passes() {
        let i = Input {
            assets: vec![AssetInput { sources: vec![src(&[WAD, WAD, WAD]), src(&[WAD, WAD + 1, WAD])], spot: WAD }],
            total_assets: 10,
            total_liabilities: 9,
            max_deviation_bps: 300,
            min_sources: 2,
        };
        assert_eq!(attest(&i), Output { oracle_ok: true, solvency_ok: true, twaps: vec![WAD] });
    }

    #[test]
    fn pumped_spot_fails_oracle() {
        let i = Input {
            assets: vec![AssetInput { sources: vec![src(&[WAD, WAD, 121 * WAD]), src(&[WAD; 3])], spot: 121 * WAD }],
            total_assets: 1,
            total_liabilities: 1,
            max_deviation_bps: 300,
            min_sources: 2,
        };
        let o = attest(&i);
        assert!(!o.oracle_ok);
        assert_eq!(o.twaps[0], WAD, "median ignores the single pumped sample");
    }

    #[test]
    fn single_source_is_not_enough() {
        let i = Input { assets: vec![AssetInput { sources: vec![src(&[WAD; 3])], spot: WAD }], total_assets: 1, total_liabilities: 2, max_deviation_bps: 300, min_sources: 2 };
        let o = attest(&i);
        assert!(!o.oracle_ok);
        assert!(!o.solvency_ok);
    }
}
