const std = @import("std");

pub const url = "https://github.com/lianihossam-eng/Tetris/issues/new/choose";

test "feedback opens the Tetris issue picker" {
    try std.testing.expectEqualStrings("https://github.com/lianihossam-eng/Tetris/issues/new/choose", url);
}
