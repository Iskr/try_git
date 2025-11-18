//
//  ContentView.swift
//  CallingApp
//
//  Created on 2025-11-17.
//

import SwiftUI

struct ContentView: View {
    @State private var isInCall = false
    @State private var showJoinView = false

    var body: some View {
        NavigationView {
            HomeView(isInCall: $isInCall, showJoinView: $showJoinView)
                .navigationBarHidden(true)
        }
    }
}

struct ContentView_Previews: PreviewProvider {
    static var previews: some View {
        ContentView()
    }
}
